import React from 'react';

interface LogiNoteLogoMarkProps {
  className?: string;
  title?: string;
}

/**
 * LogiNote 世界树标志。
 *
 * 使用单色遮罩让细密树冠、莫比乌斯环和根系在不同主题下自动继承
 * 当前文字颜色，同时保留高分辨率母版的自然轮廓。
 */
export const LogiNoteLogoMark: React.FC<LogiNoteLogoMarkProps> = ({ className, title }) => (
  <span
    className={['loginote-logo-mark', className].filter(Boolean).join(' ')}
    role={title ? 'img' : undefined}
    aria-label={title}
    aria-hidden={title ? undefined : true}
  />
);
