/**
 * go2rtc restreams of a Frigate camera: what each one carries (checked with an RTSP DESCRIBE, no video is read),
 * and which one to use by default.
 */
import { RtspClient, isAac, isG711, isOpus, spsResolution } from './rtsp.js';

export interface RestreamSettings {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface StreamInfo {
  /** go2rtc stream name. */
  name: string;
  /** Frigate's label for it (live.streams key), if any. */
  label?: string;
  url: string;
  ok: boolean;
  /** H264, H265, ... */
  codec?: string;
  width?: number;
  height?: number;
  profileLevelId?: string;
  /** Audio codecs in the stream: AAC, PCMA, PCMU, OPUS, ... */
  audio: string[];
  error?: string;
}

/** The restream URL; audio=all also brings go2rtc's Opus track (when the stream has one) for live view. */
export function restreamUrl(settings: RestreamSettings, stream: string, withOpus = true): string {
  const auth = settings.username ? `${encodeURIComponent(settings.username)}:${encodeURIComponent(settings.password ?? '')}@` : '';
  const host = settings.host.includes(':') ? `[${settings.host}]` : settings.host;
  // without Opus: only the camera's own audio codecs, so go2rtc does not start an Opus transcoder for us
  const query = withOpus ? 'video=all&audio=all' : 'video=all&audio=aac&audio=pcma&audio=pcmu';
  return `rtsp://${auth}${host}:${settings.port}/${encodeURIComponent(stream)}?${query}`;
}

export const redactUrl = (url: string): string => url.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@');

const audioName = (codec: string): string => (/mpeg4-generic/i.test(codec) ? 'AAC' : codec.toUpperCase());

/** DESCRIBE one restream: video codec and size (from the SPS), audio tracks. */
export async function checkStream(settings: RestreamSettings, name: string, label?: string, timeoutMs = 6000): Promise<StreamInfo> {
  const url = restreamUrl(settings, name);
  const info: StreamInfo = { name, label, url, ok: false, audio: [] };
  const client = new RtspClient(url);
  try {
    const description = await client.describe(timeoutMs);
    if (description.status !== 200) {
      info.error = description.status === 401 ? 'go2rtc asks for a user and password (restream settings)' : description.status === 404 ? 'go2rtc has no such stream' : `DESCRIBE answered ${description.status}`;
      return info;
    }
    const video = description.video;
    info.codec = video?.codec?.toUpperCase();
    info.profileLevelId = video?.profileLevelId;
    const size = video?.sps ? spsResolution(video.sps) : undefined;
    info.width = size?.width;
    info.height = size?.height;
    info.audio = description.audios.filter((a) => isAac(a) || isG711(a) || isOpus(a) || a.codec).map((a) => audioName(a.codec));
    if (!video) info.error = 'no video (is the camera online in Frigate?)';
    else if (!/^h264$/i.test(video.codec)) info.error = `${info.codec}: SmartThings takes H.264 only`;
    info.ok = !info.error;
    return info;
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error);
    return info;
  } finally {
    client.close();
  }
}

/**
 * The default stream: the best H.264 up to 1080p (not below 720p when a bigger one exists), else the smallest
 * H.264 one; streams without a known size come after those with one.
 */
export function defaultStream(streams: StreamInfo[]): StreamInfo | undefined {
  const usable = streams.filter((s) => s.ok);
  if (!usable.length) return undefined;
  const sized = usable.filter((s) => s.height).sort((a, b) => b.height! - a.height!);
  return sized.find((s) => s.height! <= 1080) ?? sized[sized.length - 1] ?? usable[0];
}

/** "Main · 1920×1080 · H264 · AAC + OPUS" style label for the settings and the page. */
export function streamTitle(s: StreamInfo): string {
  const size = s.width && s.height ? `${s.width}×${s.height}` : '';
  return [s.label ? `${s.label} (${s.name})` : s.name, size, s.codec, s.audio.length ? s.audio.join(' + ') : 'no audio'].filter(Boolean).join(' · ');
}
