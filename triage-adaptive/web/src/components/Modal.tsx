import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  /** Runs once the native dialog has closed, however it closed (Esc, Cancel, or open turned false). */
  onClose: () => void;
  labelledBy: string;
  className?: string;
  children: ReactNode;
}

/** A native modal <dialog>. Its content is mounted only while open. */
export function Modal({ open, onClose, labelledBy, className, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const handler = (): void => onCloseRef.current();
    d.addEventListener('close', handler);
    return () => d.removeEventListener('close', handler);
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className={className} aria-labelledby={labelledBy}>
      {open ? children : null}
    </dialog>
  );
}
