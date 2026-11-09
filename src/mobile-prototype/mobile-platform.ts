/** Native capabilities are injected by apps/android; browser previews stay dependency-free. */
export type NativeRecording = {
  id?: string; title?: string; state: 'idle' | 'recording' | 'paused' | 'stopped' | 'interrupted';
  durationMs: number; fileUri?: string; error?: string; createdAt?: number;
};
export type MobilePlatform = {
  isNative: boolean;
  recorder?: {
    start(options: { id: string; title: string }): Promise<NativeRecording>;
    pause(): Promise<NativeRecording>;
    resume(): Promise<NativeRecording>;
    stop(): Promise<NativeRecording>;
    getStatus(): Promise<NativeRecording>;
    listRecordings(): Promise<{ recordings: NativeRecording[] }>;
    deleteRecording(options: { id: string }): Promise<void>;
  };
  takePhoto?: () => Promise<File | undefined>;
  fileUrl?: (uri: string) => string;
  onRestoredPhoto?: (handler: (file: File) => void) => () => void;
};
let platform: MobilePlatform = { isNative: false };
export function configureMobilePlatform(next: MobilePlatform) { platform = next; }
export function getMobilePlatform(): MobilePlatform { return platform; }
