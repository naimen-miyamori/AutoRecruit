import * as Dialog from '@radix-ui/react-dialog';
import { ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

export function SafetyDialog({
  trigger,
  title,
  description,
  tone = 'danger',
  facts,
  confirmLabel,
  busy,
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  tone?: 'danger' | 'warning';
  facts: Array<{ label: string; value: ReactNode }>;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={(value) => { setOpen(value); if (!value) setAccepted(false); }}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Close className="icon-button dialog-close" aria-label="关闭"><X size={17} /></Dialog.Close>
          <div className={`risk-heading risk-${tone}`}><ShieldAlert size={22} /><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div></div>
          <div className="detail-grid">{facts.map((fact) => <div className="detail-cell" key={fact.label}><span>{fact.label}</span><strong>{fact.value}</strong></div>)}</div>
          <label className="checkbox-field risk-accept"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />我已核对目标身份、操作内容和外部影响</label>
          <div className="dialog-actions"><Dialog.Close className="secondary-button">取消</Dialog.Close><button className={tone === 'danger' ? 'danger-button' : 'primary-button'} type="button" disabled={!accepted || busy} onClick={() => { onConfirm(); setOpen(false); }}>{busy ? '提交中' : confirmLabel}</button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
