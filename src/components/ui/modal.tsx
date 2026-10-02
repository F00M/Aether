"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Hide the visible heading but keep it for screen readers. */
  hideTitle?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
};

// How long the dialog takes to leave; matches .dialog-closing in globals.css.
const CLOSE_MS = 140;

export function Modal({
  open,
  onClose,
  title,
  hideTitle = false,
  children,
  footer,
  maxWidth = "max-w-md",
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  // An owner that keeps the dialog mounted and reopens it gets a fresh entrance, not a stuck exit.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setClosing(false);
  }

  // The owner usually passes a new `onClose` on every render. Reading it through a ref keeps the
  // effect below from re-running each time — it moves focus to the panel, which would otherwise
  // pull the caret out of a field inside the dialog whenever the page behind it re-rendered.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const leaving = useRef(false);

  // Dismissing plays the exit first; the owner only unmounts the dialog once it has left.
  const dismiss = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    setClosing(true);
    window.setTimeout(() => onCloseRef.current(), CLOSE_MS);
  }, []);

  useEffect(() => {
    if (!open) return;
    leaving.current = false;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKey);

    // Locking the scroll removes the scrollbar; the page is padded by its width so nothing behind
    // the dialog jumps sideways.
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    const previousOverflow = document.body.style.overflow;
    const previousPadding = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;

    // Move focus into the dialog so keyboard users aren't left behind it.
    panelRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPadding;
    };
  }, [open, dismiss]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {/* A plain dim, no blur: blurring the page behind costs a full-screen repaint per frame. */}
      <div
        className={`absolute inset-0 bg-ink/35 ${closing ? "overlay-closing" : "animate-fade"}`}
        onClick={dismiss}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative flex max-h-[88dvh] w-full ${maxWidth} flex-col overflow-hidden rounded-t-[22px] border border-line bg-surface shadow-pop outline-none sm:rounded-card ${
          closing ? "dialog-closing" : "animate-dialog"
        }`}
      >
        {/* On a phone the dialog is a sheet; the handle says it came from below. */}
        <span aria-hidden="true" className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-2 sm:hidden" />
        <header className="flex items-center justify-between border-b border-line px-5 pb-3.5 pt-2.5 sm:py-4">
          <h2 className={hideTitle ? "sr-only" : "text-[15px] font-semibold tracking-tight"}>
            {title}
          </h2>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close"
            className="pressable -mr-1.5 rounded-lg p-1.5 text-ink-3 hover:bg-inset hover:text-ink"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>

        {footer ? <footer className="border-t border-line px-5 py-4">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
