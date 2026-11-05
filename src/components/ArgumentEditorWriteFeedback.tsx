export function ArgumentEditorWriteFeedback({ writing, error }: { writing?: 'save' | 'delete' | null; error?: string }) {
  if (!writing && !error) return null;
  return <p className="argument-editor-write-feedback" role={error ? 'alert' : 'status'}>
    {error || `正在${writing === 'delete' ? '删除' : '保存'}，等待写入完成后退出…`}
  </p>;
}
