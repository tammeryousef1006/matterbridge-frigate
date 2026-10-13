/**
 * PTZ (experimental): Matter's camera pan/tilt/zoom cluster (CameraAvSettingsUserLevelManagement) on cameras that
 * Frigate controls over ONVIF. Matter commands are sent on to Frigate as its PTZ commands (`<camera>/ptz` over
 * Frigate's WebSocket or MQTT):
 * - relative moves (the arrow buttons) -> MOVE_LEFT / MOVE_RIGHT / MOVE_UP / MOVE_DOWN for a time that grows with
 *   the step, then STOP; zoom -> ZOOM_IN / ZOOM_OUT, then STOP
 * - absolute positions -> the same, as a move from the last known position (Frigate has no absolute command, so the
 *   position the controller sees is an estimate)
 * - presets -> the camera's own presets as Frigate lists them; going to one sends PRESET_<name>. Presets cannot be
 *   saved or removed through Frigate: save them in the camera's app.
 */
import { CameraAvSettingsUserLevelManagementServer } from 'matterbridge/matter/behaviors';
import { CameraAvSettingsUserLevelManagement } from 'matterbridge/matter/clusters';
import { Status, StatusResponseError } from 'matterbridge/matter/types';

type Log = (level: 'info' | 'warn' | 'debug', message: string) => void;

/** What Frigate says about a camera's PTZ (`/api/<camera>/ptz/info`). */
export interface FrigatePtzInfo {
  /** pt, zoom, pt-r, zoom-r, zoom-a, focus, pt-r-fov */
  features: string[];
  /** Preset names (Frigate keeps them in lower case). */
  presets: string[];
}

export const hasPtz = (info?: FrigatePtzInfo): boolean => !!info && (info.features.includes('pt') || info.features.includes('zoom'));

/** Matter's ranges for the estimated position (degrees; zoom 1..ZOOM_MAX). */
export const PAN_RANGE = { min: -180, max: 180 };
export const TILT_RANGE = { min: -90, max: 90 };
export const ZOOM_MAX = 10;
/** How long a continuous move runs per degree / per zoom step (Frigate moves at half speed). */
const MS_PER_DEGREE = 25;
const MS_PER_ZOOM_STEP = 400;
const MIN_MOVE_MS = 150;
const MAX_MOVE_MS = 3000;

export interface PtzStep {
  command: 'MOVE_LEFT' | 'MOVE_RIGHT' | 'MOVE_UP' | 'MOVE_DOWN' | 'ZOOM_IN' | 'ZOOM_OUT';
  ms: number;
}

/** A relative move in Matter units to Frigate's continuous moves (pan right and tilt up are positive). */
export function stepsFor(delta: { pan?: number; tilt?: number; zoom?: number }, info: FrigatePtzInfo): PtzStep[] {
  const steps: PtzStep[] = [];
  const time = (amount: number, per: number): number => Math.round(Math.min(MAX_MOVE_MS, Math.max(MIN_MOVE_MS, Math.abs(amount) * per)));
  if (info.features.includes('pt')) {
    if (delta.pan) steps.push({ command: delta.pan > 0 ? 'MOVE_RIGHT' : 'MOVE_LEFT', ms: time(delta.pan, MS_PER_DEGREE) });
    if (delta.tilt) steps.push({ command: delta.tilt > 0 ? 'MOVE_UP' : 'MOVE_DOWN', ms: time(delta.tilt, MS_PER_DEGREE) });
  }
  if (info.features.includes('zoom') && delta.zoom) steps.push({ command: delta.zoom > 0 ? 'ZOOM_IN' : 'ZOOM_OUT', ms: time(delta.zoom, MS_PER_ZOOM_STEP) });
  return steps;
}

/** The Matter preset list for Frigate's presets: ids 1..n in Frigate's order. */
export function matterPresets(info: FrigatePtzInfo): { presetId: number; name: string; settings: { pan: number; tilt: number; zoom: number } }[] {
  return info.presets.slice(0, 32).map((name, i) => ({ presetId: i + 1, name: name.slice(0, 32), settings: { pan: 0, tilt: 0, zoom: 1 } }));
}

/** Sends one command to Frigate (`<camera>/ptz`); false when no connection to Frigate is up. */
export type PtzSend = (command: string) => boolean;

/** Runs the steps one after another (each a move, then STOP), never overlapping. */
export class PtzRunner {
  private queue: Promise<void> = Promise.resolve();
  sent: string[] = [];

  constructor(
    private readonly camera: string,
    private readonly send: PtzSend,
    private readonly log: Log,
  ) {}

  private command(command: string): void {
    const ok = this.send(command);
    this.sent.push(ok ? command : `${command} (not sent: no connection to Frigate)`);
    if (this.sent.length > 50) this.sent.shift();
    if (!ok) this.log('warn', `${this.camera}: PTZ ${command} not sent: no connection to Frigate`);
    else this.log('debug', `${this.camera}: PTZ ${command} -> Frigate`);
  }

  moves(steps: PtzStep[]): Promise<void> {
    this.queue = this.queue.then(async () => {
      for (const step of steps) {
        this.command(step.command);
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        this.command('STOP');
      }
    });
    return this.queue;
  }

  preset(name: string): Promise<void> {
    this.queue = this.queue.then(() => this.command(`PRESET_${name}`));
    return this.queue;
  }
}

/** The PTZ behavior for one camera, and its starting state. */
export function createPtz(camera: string, info: FrigatePtzInfo, runner: PtzRunner, log: Log) {
  const presets = matterPresets(info);
  const F = CameraAvSettingsUserLevelManagement.Feature;
  const features = [
    ...(info.features.includes('pt') ? [F.MechanicalPan, F.MechanicalTilt] : []),
    ...(info.features.includes('zoom') ? [F.MechanicalZoom] : []),
    ...(presets.length ? [F.MechanicalPresets] : []),
  ];
  const Base = CameraAvSettingsUserLevelManagementServer.with(...features);
  type Position = { pan?: number; tilt?: number; zoom?: number };
  const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

  // matter.js' server with the commands sent on to Frigate; the position is Matter's estimate
  class FrigatePtzServer extends Base {
    private get position(): Position {
      return (this.state as unknown as { mptzPosition: Position }).mptzPosition;
    }

    private set position(value: Position) {
      (this.state as unknown as { mptzPosition: Position }).mptzPosition = value;
    }

    private moveBy(delta: Position, text: string): void {
      const current = this.position;
      this.position = {
        pan: info.features.includes('pt') ? clamp((current.pan ?? 0) + (delta.pan ?? 0), PAN_RANGE.min, PAN_RANGE.max) : undefined,
        tilt: info.features.includes('pt') ? clamp((current.tilt ?? 0) + (delta.tilt ?? 0), TILT_RANGE.min, TILT_RANGE.max) : undefined,
        zoom: info.features.includes('zoom') ? clamp((current.zoom ?? 1) + (delta.zoom ?? 0), 1, ZOOM_MAX) : undefined,
      };
      const steps = stepsFor(delta, info);
      log('info', `${camera}: PTZ ${text} -> ${steps.map((s) => `${s.command} ${s.ms} ms`).join(', ') || 'nothing this camera can do'}`);
      void runner.moves(steps);
    }

    override mptzRelativeMove(request: CameraAvSettingsUserLevelManagement.MptzRelativeMoveRequest): void {
      if (request.panDelta === undefined && request.tiltDelta === undefined && request.zoomDelta === undefined) throw new StatusResponseError('panDelta, tiltDelta or zoomDelta is needed', Status.InvalidCommand);
      this.moveBy({ pan: request.panDelta ?? 0, tilt: request.tiltDelta ?? 0, zoom: request.zoomDelta ?? 0 }, `move pan ${request.panDelta ?? 0}°, tilt ${request.tiltDelta ?? 0}°, zoom ${request.zoomDelta ?? 0}`);
    }

    override mptzSetPosition(request: CameraAvSettingsUserLevelManagement.MptzSetPositionRequest): void {
      if (request.pan === undefined && request.tilt === undefined && request.zoom === undefined) throw new StatusResponseError('pan, tilt or zoom is needed', Status.InvalidCommand);
      if (request.pan !== undefined && (request.pan < PAN_RANGE.min || request.pan > PAN_RANGE.max)) throw new StatusResponseError(`pan ${request.pan} is outside ${PAN_RANGE.min}..${PAN_RANGE.max}`, Status.ConstraintError);
      if (request.tilt !== undefined && (request.tilt < TILT_RANGE.min || request.tilt > TILT_RANGE.max)) throw new StatusResponseError(`tilt ${request.tilt} is outside ${TILT_RANGE.min}..${TILT_RANGE.max}`, Status.ConstraintError);
      if (request.zoom !== undefined && (request.zoom < 1 || request.zoom > ZOOM_MAX)) throw new StatusResponseError(`zoom ${request.zoom} is outside 1..${ZOOM_MAX}`, Status.ConstraintError);
      const current = this.position;
      const delta = {
        pan: request.pan === undefined ? 0 : request.pan - (current.pan ?? 0),
        tilt: request.tilt === undefined ? 0 : request.tilt - (current.tilt ?? 0),
        zoom: request.zoom === undefined ? 0 : request.zoom - (current.zoom ?? 1),
      };
      this.moveBy(delta, `go to pan ${request.pan ?? '-'}°, tilt ${request.tilt ?? '-'}°, zoom ${request.zoom ?? '-'} (from the estimated position)`);
    }

    override mptzMoveToPreset(request: CameraAvSettingsUserLevelManagement.MptzMoveToPresetRequest): void {
      const name = info.presets[request.presetId - 1];
      if (!name) throw new StatusResponseError(`preset ${request.presetId} does not exist`, Status.NotFound);
      log('info', `${camera}: PTZ preset ${request.presetId} "${name}" -> PRESET_${name}`);
      // the real position after a preset is unknown: count from the middle again
      this.position = { pan: info.features.includes('pt') ? 0 : undefined, tilt: info.features.includes('pt') ? 0 : undefined, zoom: info.features.includes('zoom') ? 1 : undefined };
      void runner.preset(name);
    }

    override mptzSavePreset(): void {
      throw new StatusResponseError('Presets are saved in the camera itself (its app or web page); Frigate lists them here after a restart', Status.UnsupportedCommand);
    }

    override mptzRemovePreset(): void {
      throw new StatusResponseError('Presets are removed in the camera itself (its app or web page)', Status.UnsupportedCommand);
    }
  }

  const Behavior = FrigatePtzServer;
  const defaults: Record<string, unknown> = {
    mptzPosition: { pan: info.features.includes('pt') ? 0 : undefined, tilt: info.features.includes('pt') ? 0 : undefined, zoom: info.features.includes('zoom') ? 1 : undefined },
    movementState: CameraAvSettingsUserLevelManagement.PhysicalMovement.Idle,
    ...(info.features.includes('pt') ? { panMin: PAN_RANGE.min, panMax: PAN_RANGE.max, tiltMin: TILT_RANGE.min, tiltMax: TILT_RANGE.max } : {}),
    ...(info.features.includes('zoom') ? { zoomMax: ZOOM_MAX } : {}),
    ...(presets.length ? { maxPresets: presets.length, mptzPresets: presets } : {}),
  };
  return { Behavior, defaults, features: features.map(String) };
}
