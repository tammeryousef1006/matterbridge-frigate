/**
 * Recording (Matter Push AV). matter.js only ships empty shells for these clusters, so they are
 * implemented here far enough to accept and log everything a hub sends:
 * - on the camera's own node root: TLS Certificate Management, TLS Client Management, Time Synchronization
 * - on the camera endpoint: Push AV Stream Transport
 * Clips are recorded and uploaded by pushav.ts.
 */
import * as crypto from 'node:crypto';

import { PushAvStreamTransportServer, TimeSynchronizationServer, TlsCertificateManagementServer, TlsClientManagementServer, ZoneManagementServer } from 'matterbridge/matter/behaviors';
import { PushAvStreamTransport, TimeSynchronization, TlsCertificateManagement, TlsClientManagement, ZoneManagement } from 'matterbridge/matter/clusters';
import { StatusResponse } from 'matterbridge/matter/types';

import { Clip, PreRollBuffer, RecordingStore, TimeControl } from './pushav.js';
import { RtspSource } from './rtsp.js';

type Log = (message: string) => void;
let log: Log = () => undefined;
export function setRecordingLog(fn: Log): void {
  log = fn;
}

/** JSON for the log, with byte arrays as hex (or text when printable). */
export function show(value: unknown): string {
  return JSON.stringify(value, (_key, value2: unknown) => {
    const v = value2;
    if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
      const b = buf(v);
      const text = b.toString('utf8');
      if (/^[\x20-\x7e]+$/.test(text)) return `"${text}"`;
      const hex = b.toString('hex');
      return hex.length > 128 ? `${hex.slice(0, 128)}... (${b.length} bytes)` : hex;
    }
    if (typeof v === 'bigint') return v.toString();
    return v;
  });
}

/** Matter Bytes (Uint8Array or ArrayBuffer) as a Buffer. */
const buf = (b: unknown): Buffer => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : (b as Uint8Array));

// ----- DER helpers for the certificate signing request -----
function der(tag: number, content: Buffer): Buffer {
  const n = content.length;
  const length = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, content]);
}
const seq = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts));
const oid = (hex: string): Buffer => der(0x06, Buffer.from(hex, 'hex'));

/** PKCS#10 CSR (DER) for an EC P-256 key, subject CN=<name>, signed with ECDSA-SHA256. */
function createCsr(privateKey: crypto.KeyObject, publicKey: crypto.KeyObject, name: string): Buffer {
  const subject = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from(name)))));
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const info = seq(der(0x02, Buffer.from([0])), subject, spki, Buffer.from([0xa0, 0x00]));
  const signature = crypto.sign('sha256', info, privateKey);
  return seq(info, seq(oid('2a8648ce3d040302')), der(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

interface ContextLike {
  fabric?: number;
}
const fabricOf = (context: unknown): number => (context as ContextLike | undefined)?.fabric ?? 1;

/** What one recording camera needs: its stream, its pre-roll and the TLS material the hub gives it. */
export interface RecordingContext {
  name: string;
  source: RtspSource;
  preRoll: PreRollBuffer;
  store: RecordingStore;
  width: number;
  height: number;
  rotation?: number;
  log: Log;
}

interface Transport {
  clip?: Clip;
  url?: string;
  session: number;
  blindUntil: number;
}

/** The recording behaviors for one camera (each camera has its own Matter node, keys and clips). */
export function createRecording(ctx: RecordingContext) {
  const { store } = ctx;
  const say = ctx.log;
  const transports = new Map<number, Transport>();

  // ----- TLS Certificate Management (root) -----
  class TlsCertificates extends TlsCertificateManagementServer {
    override provisionRootCertificate(request: TlsCertificateManagement.ProvisionRootCertificateRequest): TlsCertificateManagement.ProvisionRootCertificateResponse {
      say(`[hub] TLS ProvisionRootCertificate ${show({ caid: request.caid, bytes: buf(request.certificate).length })}`);
      const list = [...this.state.provisionedRootCertificates];
      const caid = request.caid ?? Math.max(0, ...list.map((c) => c.caid + 1));
      const entry = { caid, certificate: request.certificate, fabricIndex: fabricOf(this.context) } as TlsCertificateManagement.TlsCert;
      this.state.provisionedRootCertificates = [...list.filter((c) => c.caid !== caid), entry];
      store.data.roots[caid] = buf(request.certificate).toString('base64');
      store.save();
      return { caid };
    }

    override findRootCertificate(request: TlsCertificateManagement.FindRootCertificateRequest): TlsCertificateManagement.FindRootCertificateResponse {
      say(`[hub] TLS FindRootCertificate ${show(request)}`);
      return { certificateDetails: this.state.provisionedRootCertificates.filter((c) => request.caid === null || c.caid === request.caid) };
    }

    override lookupRootCertificate(request: TlsCertificateManagement.LookupRootCertificateRequest): TlsCertificateManagement.LookupRootCertificateResponse {
      say(`[hub] TLS LookupRootCertificate ${show(request)}`);
      const match = this.state.provisionedRootCertificates.find((c) => c.certificate && crypto.createHash('sha256').update(buf(c.certificate)).digest().equals(buf(request.fingerprint)));
      return { caid: match?.caid ?? 0 };
    }

    override removeRootCertificate(request: TlsCertificateManagement.RemoveRootCertificateRequest): void {
      say(`[hub] TLS RemoveRootCertificate ${show(request)}`);
      this.state.provisionedRootCertificates = this.state.provisionedRootCertificates.filter((c) => c.caid !== request.caid);
      delete store.data.roots[request.caid];
      store.save();
    }

    override clientCsr(request: TlsCertificateManagement.ClientCsrRequest): TlsCertificateManagement.ClientCsrResponse {
      say(`[hub] TLS ClientCSR ${show(request)}`);
      const list = [...this.state.provisionedClientCertificates];
      const ccdid = request.ccdid ?? Math.max(0, ...list.map((c) => c.ccdid + 1));
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      store.data.keys[ccdid] = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      store.save();
      const csr = createCsr(privateKey, publicKey, `matterbridge-camera-${ccdid}`);
      const nonceSignature = crypto.sign('sha256', buf(request.nonce), { key: privateKey, dsaEncoding: 'ieee-p1363' });
      if (!list.some((c) => c.ccdid === ccdid)) {
        this.state.provisionedClientCertificates = [...list, { ccdid, clientCertificate: null, fabricIndex: fabricOf(this.context) } as TlsCertificateManagement.TlsClientCertificateDetail];
      }
      say(`TLS: created a key and CSR for client certificate ${ccdid} (${csr.length} B), key saved`);
      return { ccdid, csr, nonceSignature };
    }

    override provisionClientCertificate(request: TlsCertificateManagement.ProvisionClientCertificateRequest): void {
      say(`[hub] TLS ProvisionClientCertificate ${show({ ccdid: request.ccdid, bytes: buf(request.clientCertificate).length, intermediates: request.intermediateCertificates.length })}`);
      this.state.provisionedClientCertificates = [
        ...this.state.provisionedClientCertificates.filter((c) => c.ccdid !== request.ccdid),
        { ccdid: request.ccdid, clientCertificate: request.clientCertificate, intermediateCertificates: request.intermediateCertificates, fabricIndex: fabricOf(this.context) } as TlsCertificateManagement.TlsClientCertificateDetail,
      ];
      store.data.clients[request.ccdid] = { cert: buf(request.clientCertificate).toString('base64'), intermediates: request.intermediateCertificates.map((c) => buf(c).toString('base64')) };
      store.save();
    }

    override findClientCertificate(request: TlsCertificateManagement.FindClientCertificateRequest): TlsCertificateManagement.FindClientCertificateResponse {
      say(`[hub] TLS FindClientCertificate ${show(request)}`);
      return { certificateDetails: this.state.provisionedClientCertificates.filter((c) => request.ccdid === null || c.ccdid === request.ccdid) };
    }

    override lookupClientCertificate(request: TlsCertificateManagement.LookupClientCertificateRequest): TlsCertificateManagement.LookupClientCertificateResponse {
      say(`[hub] TLS LookupClientCertificate ${show(request)}`);
      return { ccdid: this.state.provisionedClientCertificates[0]?.ccdid ?? 0 };
    }

    override removeClientCertificate(request: TlsCertificateManagement.RemoveClientCertificateRequest): void {
      say(`[hub] TLS RemoveClientCertificate ${show(request)}`);
      this.state.provisionedClientCertificates = this.state.provisionedClientCertificates.filter((c) => c.ccdid !== request.ccdid);
      delete store.data.keys[request.ccdid];
      delete store.data.clients[request.ccdid];
      store.save();
    }
  }

  // ----- TLS Client Management (root): where clips are uploaded -----
  class TlsClients extends TlsClientManagementServer {
    override provisionEndpoint(request: TlsClientManagement.ProvisionEndpointRequest): TlsClientManagement.ProvisionEndpointResponse {
      const hostname = buf(request.hostname).toString('utf8');
      say(`[hub] TLS ProvisionEndpoint ${show({ ...request, hostname })}`);
      const list = [...this.state.provisionedEndpoints];
      const endpointId = request.endpointId ?? Math.max(1, ...list.map((e) => e.endpointId + 1));
      const entry = { endpointId, hostname: request.hostname, port: request.port, caid: request.caid, ccdid: request.ccdid, referenceCount: 0, fabricIndex: fabricOf(this.context) } as TlsClientManagement.TlsEndpoint;
      this.state.provisionedEndpoints = [...list.filter((e) => e.endpointId !== endpointId), entry];
      store.data.endpoints[endpointId] = { hostname, port: request.port, caid: request.caid, ccdid: request.ccdid ?? 0 };
      store.save();
      return { endpointId };
    }

    override findEndpoint(request: TlsClientManagement.FindEndpointRequest): TlsClientManagement.FindEndpointResponse {
      say(`[hub] TLS FindEndpoint ${show(request)}`);
      const endpoint = this.state.provisionedEndpoints.find((e) => e.endpointId === request.endpointId);
      if (!endpoint) throw new TlsClientManagement.ClientCertificateNotFoundError(`endpoint ${request.endpointId} not found`);
      return { endpoint };
    }

    override removeEndpoint(request: TlsClientManagement.RemoveEndpointRequest): void {
      say(`[hub] TLS RemoveEndpoint ${show(request)}`);
      this.state.provisionedEndpoints = this.state.provisionedEndpoints.filter((e) => e.endpointId !== request.endpointId);
      delete store.data.endpoints[request.endpointId];
      store.save();
    }
  }

  // ----- Time Synchronization (root): certificates need a correct clock -----
  class TimeSync extends TimeSynchronizationServer {
    override setUtcTime(request: TimeSynchronization.SetUtcTimeRequest): void {
      say(`[hub] TimeSync SetUTCTime ${show(request)}`);
      this.state.utcTime = request.utcTime;
      this.state.granularity = request.granularity;
    }
  }

  // ----- Push AV Stream Transport (camera endpoint): recordings -----
  class PushAv extends PushAvStreamTransportServer {
    override allocatePushTransport(request: PushAvStreamTransport.AllocatePushTransportRequest): PushAvStreamTransport.AllocatePushTransportResponse {
      say(`[hub] PushAV AllocatePushTransport ${show(request.transportOptions)}`);
      const list = [...this.state.currentConnections];
      const connectionId = Math.max(0, ...list.map((c) => c.connectionId + 1));
      const transportConfiguration = {
        connectionId,
        transportStatus: PushAvStreamTransport.TransportStatus.Active,
        transportOptions: request.transportOptions,
        fabricIndex: fabricOf(this.context),
      } as PushAvStreamTransport.TransportConfiguration;
      try {
        this.state.currentConnections = [...list, transportConfiguration];
      } catch (error) {
        say(`PushAV: could not store transport ${connectionId}: ${String(error)}`);
      }
      say(`PushAV: transport ${connectionId} allocated -> ${request.transportOptions.url} (trigger ${PushAvStreamTransport.TransportTriggerType[request.transportOptions.triggerOptions.triggerType] ?? request.transportOptions.triggerOptions.triggerType})`);
      return { transportConfiguration };
    }

    override deallocatePushTransport(request: PushAvStreamTransport.DeallocatePushTransportRequest): void {
      say(`[hub] PushAV DeallocatePushTransport ${show(request)}`);
      transports.get(request.connectionId)?.clip?.stop();
      transports.delete(request.connectionId);
      this.state.currentConnections = this.state.currentConnections.filter((c) => c.connectionId !== request.connectionId);
    }

    override modifyPushTransport(request: PushAvStreamTransport.ModifyPushTransportRequest): void {
      say(`[hub] PushAV ModifyPushTransport ${show(request)}`);
      this.state.currentConnections = this.state.currentConnections.map((c) => (c.connectionId === request.connectionId ? { ...c, transportOptions: request.transportOptions } : c));
    }

    override setTransportStatus(request: PushAvStreamTransport.SetTransportStatusRequest): void {
      say(`[hub] PushAV SetTransportStatus ${show(request)}`);
      this.state.currentConnections = this.state.currentConnections.map((c) => (request.connectionId === null || c.connectionId === request.connectionId ? { ...c, transportStatus: request.transportStatus } : c));
      if (request.transportStatus === PushAvStreamTransport.TransportStatus.Inactive) {
        for (const [id, transport] of transports) if (request.connectionId === null || request.connectionId === id) transport.clip?.stop();
      }
    }

    override manuallyTriggerTransport(request: PushAvStreamTransport.ManuallyTriggerTransportRequest): void {
      say(`[hub] PushAV ManuallyTriggerTransport ${show(request)}`);
      const config = this.state.currentConnections.find((c) => c.connectionId === request.connectionId);
      if (!config?.transportOptions) throw new StatusResponse.NotFoundError(`transport ${request.connectionId} not found`);
      if (config.transportStatus !== PushAvStreamTransport.TransportStatus.Active) throw new PushAvStreamTransport.InvalidTransportStatusError('transport is inactive');
      if (config.transportOptions.triggerOptions.triggerType === PushAvStreamTransport.TransportTriggerType.Continuous) throw new PushAvStreamTransport.InvalidTriggerTypeError('continuous transport');
      const time = request.timeControl ?? config.transportOptions.triggerOptions.motionTimeControl ?? { initialDuration: 10, augmentationDuration: 0, maxDuration: 30, blindDuration: 0 };
      this.trigger(config, time, request.activationReason);
    }

    override findTransport(request: PushAvStreamTransport.FindTransportRequest): PushAvStreamTransport.FindTransportResponse {
      say(`[hub] PushAV FindTransport ${show(request)}`);
      return { transportConfigurations: this.state.currentConnections.filter((c) => request.connectionId === null || c.connectionId === request.connectionId) };
    }

    /** Called by the plugin on motion: starts or extends clips of transports triggered by motion. */
    motion(active: boolean): void {
      if (!active) return;
      for (const config of this.state.currentConnections) {
        const options = config.transportOptions;
        if (!options || config.transportStatus !== PushAvStreamTransport.TransportStatus.Active) continue;
        if (options.triggerOptions.triggerType !== PushAvStreamTransport.TransportTriggerType.Motion) continue;
        const time = options.triggerOptions.motionTimeControl ?? { initialDuration: 10, augmentationDuration: 5, maxDuration: 60, blindDuration: 0 };
        this.trigger(config, time, undefined);
      }
    }

    private trigger(config: PushAvStreamTransport.TransportConfiguration, time: TimeControl, reason: PushAvStreamTransport.TriggerActivationReason | undefined): void {
      const options = config.transportOptions as PushAvStreamTransport.TransportOptions;
      const connectionId = config.connectionId;
      let transport = transports.get(connectionId);
      if (!transport) transports.set(connectionId, (transport = { session: 0, blindUntil: 0 }));
      if (transport.clip) {
        if (transport.clip.url === options.url) {
          transport.clip.extend(time.augmentationDuration);
          return;
        }
        // SmartThings moves the transport to a new clip address (ModifyPushTransport) and triggers again:
        // finish the running clip and start the new one, which gets its own pre-roll
        say(`PushAV: transport ${connectionId} has a new clip address, finishing the running clip and starting a new one`);
        transport.clip.stop();
        transport.clip = undefined;
      }
      if (Date.now() < transport.blindUntil) {
        say(`PushAV: transport ${connectionId} trigger ignored (blind period)`);
        return;
      }
      // a new clip address starts again at session_1; the same address counts up
      transport.session = transport.url === options.url ? transport.session + 1 : 1;
      transport.url = options.url;
      const session = transport.session;
      const cmaf = options.containerOptions.cmafContainerOptions;
      const clip = new Clip({
        label: `${ctx.name} #${connectionId}`,
        source: ctx.source,
        preRoll: ctx.preRoll,
        url: options.url,
        session,
        streamName: options.videoStreams?.[0]?.videoStreamName || 'video',
        audioName: options.audioStreams?.[0]?.audioStreamName || undefined,
        maxPreRollMs: options.triggerOptions.maxPreRollLen ?? 0,
        segmentMs: cmaf?.segmentDuration || 4000,
        time,
        width: ctx.width,
        height: ctx.height,
        rotation: ctx.rotation,
        tlsMaterial: () => store.tlsFor(options.tlsEndpointId),
        log: say,
      });
      transport.clip = clip;
      const triggerType = options.triggerOptions.triggerType;
      this.events.pushTransportBegin.emit({ connectionId, triggerType, activationReason: reason, containerType: PushAvStreamTransport.ContainerFormat.Cmaf, cmafSessionNumber: session }, this.context);
      clip.start();
      const endpoint = this.endpoint;
      void clip.done.then(async () => {
        const current = transports.get(connectionId);
        if (current?.clip === clip) {
          current.clip = undefined;
          current.blindUntil = Date.now() + time.blindDuration * 1000;
        }
        try {
          await endpoint.act((agent) => agent.get(PushAv).ended(connectionId, session));
        } catch (error) {
          say(`PushAV: could not send PushTransportEnd: ${String(error)}`);
        }
      });
    }

    ended(connectionId: number, session: number): void {
      this.events.pushTransportEnd.emit({ connectionId, containerType: PushAvStreamTransport.ContainerFormat.Cmaf, cmafSessionNumber: session }, this.context);
    }
  }

  return { TlsCertificates, TlsClients, TimeSync, PushAv };
}

export const pushAvDefaults = {
  supportedFormats: [{ containerFormat: PushAvStreamTransport.ContainerFormat.Cmaf, ingestMethod: PushAvStreamTransport.IngestMethods.CmafIngest }],
  currentConnections: [],
};
export const tlsCertificateDefaults = { maxRootCertificates: 5, provisionedRootCertificates: [], maxClientCertificates: 5, provisionedClientCertificates: [] };
export const tlsClientDefaults = { maxProvisioned: 5, provisionedEndpoints: [] };
export const timeSyncDefaults = { utcTime: null, granularity: TimeSynchronization.Granularity.NoTimeGranularity };

// ----- Zone Management (camera endpoint): motion zones; motion-triggered recording refers to them -----

const ZoneBase = ZoneManagementServer.with(ZoneManagement.Feature.TwoDimensionalCartesianZone, ZoneManagement.Feature.UserDefined, ZoneManagement.Feature.PerZoneSensitivity);

export class FrigateZoneServer extends ZoneBase {
  override createTwoDCartesianZone(request: ZoneManagement.CreateTwoDCartesianZoneRequest): ZoneManagement.CreateTwoDCartesianZoneResponse {
    log(`[hub] Zones CreateTwoDCartesianZone ${show(request)}`);
    const zoneId = Math.max(10, ...this.state.zones.map((z) => z.zoneId + 1));
    this.state.zones = [...this.state.zones, { zoneId, zoneType: ZoneManagement.ZoneType.TwoDcartZone, zoneSource: ZoneManagement.ZoneSource.User, twoDCartesianZone: request.zone } as ZoneManagement.ZoneInformation];
    return { zoneId };
  }

  override updateTwoDCartesianZone(request: ZoneManagement.UpdateTwoDCartesianZoneRequest): void {
    log(`[hub] Zones UpdateTwoDCartesianZone ${show(request)}`);
    this.state.zones = this.state.zones.map((z) => (z.zoneId === request.zoneId ? { ...z, twoDCartesianZone: request.zone } : z));
  }

  override removeZone(request: ZoneManagement.RemoveZoneRequest): void {
    log(`[hub] Zones RemoveZone ${show(request)}`);
    this.state.zones = this.state.zones.filter((z) => z.zoneId !== request.zoneId || z.zoneSource !== ZoneManagement.ZoneSource.User);
    this.state.triggers = this.state.triggers.filter((t) => t.zoneId !== request.zoneId);
  }

  override createOrUpdateTrigger(request: ZoneManagement.CreateOrUpdateTriggerRequest): void {
    log(`[hub] Zones CreateOrUpdateTrigger ${show(request)}`);
    this.state.triggers = [...this.state.triggers.filter((t) => t.zoneId !== request.trigger.zoneId), request.trigger];
  }

  override removeTrigger(request: ZoneManagement.RemoveTriggerRequest): void {
    log(`[hub] Zones RemoveTrigger ${show(request)}`);
    this.state.triggers = this.state.triggers.filter((t) => t.zoneId !== request.zoneId);
  }

  /** Called by the plugin when the camera reports motion starting or ending. */
  reportMotion(active: boolean): void {
    for (const zone of this.state.zones.filter((z) => z.zoneSource === ZoneManagement.ZoneSource.Mfg)) {
      if (active) this.events.zoneTriggered.emit({ zone: zone.zoneId, reason: ZoneManagement.ZoneEventTriggeredReason.Motion }, this.context);
      else this.events.zoneStopped.emit({ zone: zone.zoneId, reason: ZoneManagement.ZoneEventStoppedReason.ActionStopped }, this.context);
    }
  }
}

export function zoneDefaults(width: number, height: number): Record<string, unknown> {
  return {
    maxUserDefinedZones: 5,
    maxZones: 6,
    zones: [
      {
        zoneId: 1,
        zoneType: ZoneManagement.ZoneType.TwoDcartZone,
        zoneSource: ZoneManagement.ZoneSource.Mfg,
        twoDCartesianZone: {
          name: 'Motion',
          use: ZoneManagement.ZoneUse.Motion,
          vertices: [
            { x: 0, y: 0 },
            { x: width - 1, y: 0 },
            { x: width - 1, y: height - 1 },
            { x: 0, y: height - 1 },
          ],
          color: '#FF6600',
        },
      },
    ],
    triggers: [{ zoneId: 1, initialDuration: 10, augmentationDuration: 5, maxDuration: 120, blindDuration: 5, sensitivity: 5 }],
    sensitivityMax: 10,
    twoDCartesianMax: { x: width - 1, y: height - 1 },
  };
}
