export type NoteSaveState = 'pending' | 'saving' | 'saved' | 'error';
/** A write acknowledgment can only clear the revision that it actually wrote. */
export function acknowledgedSaveState(currentRevision: number, writtenRevision: number, success: boolean): NoteSaveState {
  return currentRevision === writtenRevision ? success ? 'saved' : 'error' : 'pending';
}
