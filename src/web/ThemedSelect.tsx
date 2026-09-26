import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export type ThemedSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  color?: string;
};

type ThemedSelectProps = {
  ariaLabel: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly ThemedSelectOption[];
  variant: "source" | "clip";
  placeholder?: string;
};

function selectable(option: ThemedSelectOption) {
  return option.value !== "" && !option.disabled;
}

function nextIndex(options: readonly ThemedSelectOption[], start: number, direction: 1 | -1) {
  for (let offset = 1; offset <= options.length; offset++) {
    const index = (start + direction * offset + options.length * 2) % options.length;
    if (selectable(options[index])) return index;
  }
  return -1;
}

export function ThemedSelect({ ariaLabel, value, onValueChange, options, variant, placeholder }: ThemedSelectProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 240, minWidth: 121, maxWidth: 320 });
  const selected = value ? options.find((option) => option.value === value) : undefined;
  const active = activeIndex >= 0 && options[activeIndex] && selectable(options[activeIndex]) ? activeIndex : -1;

  function openMenu(index = options.findIndex((option) => option.value === value && selectable(option))) {
    setActiveIndex(index >= 0 ? index : nextIndex(options, -1, 1));
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || !selectable(option)) return;
    onValueChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (!open) openMenu(direction === 1 ? nextIndex(options, -1, 1) : nextIndex(options, 0, -1));
      else setActiveIndex(nextIndex(options, active, direction));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const index = event.key === "Home" ? nextIndex(options, -1, 1) : nextIndex(options, 0, -1);
      if (open) setActiveIndex(index);
      else openMenu(index);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(active);
      else openMenu();
      return;
    }
    if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return;
    const now = Date.now();
    const previous = typeaheadRef.current;
    const search = `${now - previous.time < 700 ? previous.text : ""}${event.key.toLocaleLowerCase()}`;
    typeaheadRef.current = { text: search, time: now };
    const findMatch = (text: string) => options.findIndex((option) => selectable(option) && option.label.toLocaleLowerCase().startsWith(text));
    const match = findMatch(search);
    const index = match >= 0 ? match : findMatch(event.key.toLocaleLowerCase());
    if (index >= 0) {
      event.preventDefault();
      if (open) setActiveIndex(index);
      else openMenu(index);
    }
  }

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      // The body zoom scales fixed-position portal coordinates, but the trigger rect is already in viewport pixels.
      const zoom = rect.width / trigger.offsetWidth || 1;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const availableWidth = Math.max(1, viewportWidth - 16);
      const below = viewportHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const placeAbove = below < 120 && above > below;
      const maxHeight = Math.max(24, Math.min(240, placeAbove ? above : below));
      const minWidth = Math.min(rect.width, availableWidth);
      const width = Math.min(availableWidth, Math.max(minWidth, menu.getBoundingClientRect().width));
      const left = Math.max(8, Math.min(rect.right - width, viewportWidth - width - 8));
      const top = placeAbove ? Math.max(8, rect.top - Math.min(menu.scrollHeight * zoom, maxHeight) - 4) : rect.bottom + 4;
      setPosition({ left: left / zoom, top: top / zoom, maxHeight: maxHeight / zoom, minWidth: minWidth / zoom, maxWidth: availableWidth / zoom });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, options]);

  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const menu = menuRef.current;
    const option = menu?.querySelector<HTMLElement>(`[data-option-index="${active}"]`);
    if (!menu || !option) return;
    const menuRect = menu.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    if (optionRect.top < menuRect.top) menu.scrollTop -= menuRect.top - optionRect.top;
    else if (optionRect.bottom > menuRect.bottom) menu.scrollTop += optionRect.bottom - menuRect.bottom;
  }, [open, active, position.maxHeight]);

  useLayoutEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("focusin", closeOutside);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined}
        className={`themed-select-trigger themed-select-trigger--${variant}`}
        data-placeholder={!value || !selected ? "" : undefined}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={handleKeyDown}
      >
        {variant === "source" ? <span className="themed-select-prefix" aria-hidden="true">src</span> : null}
        {variant === "clip" && selected?.color ? <span className="themed-select-swatch" style={{ backgroundColor: selected.color }} aria-hidden="true" /> : null}
        <span className="themed-select-value">{selected?.label ?? placeholder ?? "Select…"}</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={id}
          role="listbox"
          aria-label={ariaLabel}
          className="themed-select-content"
          style={{ left: position.left, top: position.top, maxHeight: position.maxHeight, minWidth: position.minWidth, maxWidth: position.maxWidth }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.map((option, index) => option.value === "" ? null : (
            <div
              key={option.value}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={value === option.value}
              aria-disabled={option.disabled || undefined}
              data-state={value === option.value ? "checked" : undefined}
              data-highlighted={active === index ? "" : undefined}
              data-disabled={option.disabled ? "" : undefined}
              data-option-index={index}
              className="themed-select-item"
              onPointerMove={() => { if (!option.disabled && active !== index) setActiveIndex(index); }}
              onClick={() => choose(index)}
            >
              {option.color ? <span className="themed-select-swatch" style={{ backgroundColor: option.color }} aria-hidden="true" /> : null}
              <span className="themed-select-item-label">{option.label}</span>
              {value === option.value ? <span className="themed-select-indicator" aria-hidden="true">✓</span> : null}
            </div>
          ))}
          {!options.some((option) => option.value !== "") && <div className="themed-select-empty">No options</div>}
        </div>,
        document.body,
      )}
    </>
  );
}
