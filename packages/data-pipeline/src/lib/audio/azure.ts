import { spawn } from 'node:child_process';

/** The two Azure Speech calls the build needs, behind an interface so the
 * build engine is tested with a fake (no key, no network). */
export interface SpeechClient {
  /** SSML -> mono ~48 kbps mp3. */
  synthesize(ssml: string): Promise<Buffer>;
  /** Run the clip back through speech-to-text (zh-TW); returns the recognised text. */
  transcribe(ssml: string, mp3: Buffer): Promise<string>;
  /** Characters billed so far this run (Han counts double, as Azure bills it). */
  readonly usage: { billedChars: number; ttsCalls: number; sttCalls: number };
}

export class SpeechError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
  /** Wrong key/region/quota: retrying other clips would only fail the same way. */
  get fatal(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Azure bills Chinese characters as 2 each, everything else as 1; SSML tags are not billed. */
export function billableChars(text: string): number {
  let n = 0;
  for (const ch of text) n += /\p{Script=Han}/u.test(ch) ? 2 : 1;
  return n;
}

const stripTags = (ssml: string): string => ssml.replace(/<[^>]*>/g, '');

export interface AzureOptions {
  key: string;
  region: string;
  /** Minimum gap between calls. The free tier allows ~20 requests/minute per endpoint. */
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Decode mp3 -> 16 kHz mono wav with ffmpeg, if installed (the STT REST API
 * does not take mp3). Resolves null when ffmpeg is missing. */
function ffmpegToWav(mp3: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1']);
    const out: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 && out.length ? Buffer.concat(out) : null));
    p.stdin.on('error', () => undefined);
    p.stdin.end(mp3);
  });
}

export class AzureSpeechClient implements SpeechClient {
  readonly usage = { billedChars: 0, ttsCalls: 0, sttCalls: 0 };
  private readonly last = new Map<string, number>();
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private ffmpegOk: boolean | undefined;

  constructor(private readonly opts: AzureOptions) {
    this.f = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get ttsUrl() {
    return `https://${this.opts.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  }
  private get sttUrl() {
    return `https://${this.opts.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-TW&format=simple`;
  }

  /** The free-tier limit is per endpoint, so TTS and STT are paced separately. */
  private async throttle(url: string): Promise<void> {
    const gap = this.opts.minIntervalMs ?? 3200;
    const host = new URL(url).host;
    const wait = (this.last.get(host) ?? 0) + gap - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.last.set(host, Date.now());
  }

  /** One request, retrying 429/5xx with backoff (honouring Retry-After). */
  private async call(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle(url);
      const res = await this.f(url, init);
      if (res.ok) return res;
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt >= 4) {
        throw new SpeechError(`Azure Speech ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 5000);
    }
  }

  private async tts(ssml: string, format: string): Promise<Buffer> {
    const res = await this.call(this.ttsUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.opts.key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': format,
        'User-Agent': 'an-an-audio-build',
      },
      body: ssml,
    });
    this.usage.ttsCalls++;
    this.usage.billedChars += billableChars(stripTags(ssml));
    return Buffer.from(await res.arrayBuffer());
  }

  synthesize(ssml: string): Promise<Buffer> {
    return this.tts(ssml, 'audio-24khz-48kbitrate-mono-mp3');
  }

  async transcribe(ssml: string, mp3: Buffer): Promise<string> {
    let wav: Buffer | null = null;
    if (this.ffmpegOk !== false) {
      wav = await ffmpegToWav(mp3);
      this.ffmpegOk = wav !== null;
    }
    // No ffmpeg: synthesize the same SSML again as 16 kHz PCM (costs the characters twice).
    wav ??= await this.tts(ssml, 'riff-16khz-16bit-mono-pcm');
    const res = await this.call(this.sttUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.opts.key,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        Accept: 'application/json',
      },
      body: new Uint8Array(wav),
    });
    this.usage.sttCalls++;
    const json = (await res.json()) as { RecognitionStatus?: string; DisplayText?: string };
    return json.RecognitionStatus === 'Success' ? (json.DisplayText ?? '') : '';
  }
}
