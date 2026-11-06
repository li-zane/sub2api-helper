import React, { useState, useRef, useEffect, useMemo, useLayoutEffect, useId } from "react";
import { ChevronDown, Check } from "lucide-react";

// Keep the native form value, but expose one keyboard-operable visible combobox.
// Existing class names and visual rules belong to the current design unchanged.
export function CustomSelect({ id, name, value, defaultValue = "", onChange, disabled = false,
  options, children, placeholder = "请选择...", className = "", "aria-label": ariaLabel,
  "aria-labelledby": labelledBy, "aria-describedby": describedBy, width, required, form }) {
  const uid = useId();
  const triggerId = id || `${uid}-trigger`;
  const listId = `${uid}-list`;
  const [open, setOpen] = useState(false);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const currentValue = value === undefined ? internalValue : value;
  const [activeIndex, setActiveIndex] = useState(-1);
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  const [position, setPosition] = useState(null);
  const containerRef = useRef(null), triggerRef = useRef(null), menuRef = useRef(null), nativeSelectRef = useRef(null);
  const searchRef = useRef({ text: "", at: 0 });
  const parsedOptions = useMemo(() => {
    if (Array.isArray(options)) return options.map(opt => typeof opt === "object" && opt !== null ? opt : { value: opt, label: String(opt) });
    const result = [];
    const visit = nodes => React.Children.forEach(nodes, child => {
      if (!React.isValidElement(child)) return;
      if (child.type === React.Fragment || child.type === "optgroup") { visit(child.props.children); return; }
      if (child.type === "option") result.push({ value: child.props.value ?? child.props.children ?? "", label: child.props.children ?? child.props.value ?? "", disabled: Boolean(child.props.disabled) });
    });
    visit(children); return result;
  }, [options, children]);
  const selectedIndex = parsedOptions.findIndex(opt => String(opt.value ?? "") === String(currentValue ?? ""));
  const selectedOption = parsedOptions[selectedIndex];
  const displayLabel = selectedOption ? selectedOption.label : placeholder;
  const enabledIndexes = parsedOptions.flatMap((opt, index) => opt.disabled ? [] : [index]);

  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) triggerRef.current?.focus(); };
  const show = (last = false) => {
    if (disabled) return;
    setActiveIndex(selectedIndex >= 0 && !parsedOptions[selectedIndex].disabled ? selectedIndex : last ? enabledIndexes.at(-1) ?? -1 : enabledIndexes[0] ?? -1);
    setOpen(true);
  };
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!trigger) return;
    // In the top layer, CSS min-width:100% resolves against the viewport, not
    // the trigger. Set the anchor width before the first measurement.
    menu.style.minWidth = `${Math.min(trigger.getBoundingClientRect().width, window.innerWidth - 16)}px`;
    // The top layer avoids clipping by the surrounding dialog's scroll container.
    const popover = typeof menu.showPopover === "function";
    if (popover) menu.showPopover();
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger || !menu.isConnected) return;
      const rect = trigger.getBoundingClientRect();
      if (rect.bottom < 8 || rect.top > window.innerHeight - 8) { close(); return; }
      const minWidth = Math.max(0, Math.min(rect.width, window.innerWidth - 16));
      menu.style.minWidth = `${minWidth}px`;
      const width = menu.offsetWidth, height = menu.offsetHeight;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = rect.bottom + 5;
      const preferredTop = below + height > window.innerHeight - 8 && rect.top - height - 5 >= 8 ? rect.top - height - 5 : below;
      const top = Math.max(8, Math.min(preferredTop, window.innerHeight - height - 8));
      const next = { position: "fixed", left, top, right: "auto", bottom: "auto", margin: 0, minWidth, visibility: "visible" };
      setPosition(previous => previous?.left === left && previous?.top === top && previous?.minWidth === minWidth ? previous : next);
    };
    place();
    const outside = event => { if (!containerRef.current?.contains(event.target)) close(); };
    // Focusing a partially visible trigger can scroll the modal just after
    // click. Re-anchor instead of dismissing the menu on that delayed scroll.
    const scroll = event => { if (!menu.contains(event.target)) place(); };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", place);
      if (popover && menu.matches(":popover-open")) menu.hidePopover();
    };
  }, [open]);
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const scroller = menuRef.current?.querySelector(".custom-select-options");
    const option = scroller?.querySelector(`[data-option-index="${activeIndex}"]`);
    if (!option) return;
    // scrollIntoView also scrolls the surrounding modal, which can move the
    // anchor and immediately dismiss a freshly opened top-layer menu.
    const bounds = scroller.getBoundingClientRect(), item = option.getBoundingClientRect();
    if (item.top < bounds.top) scroller.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) scroller.scrollTop += item.bottom - bounds.bottom;
  }, [open, activeIndex]);

  const handleSelect = val => {
    if (disabled) return;
    const next = String(val ?? "");
    if (nativeSelectRef.current) nativeSelectRef.current.value = next;
    if (value === undefined) setInternalValue(next);
    if (String(currentValue ?? "") !== next) onChange?.({ target: { value: next, id, name: name || id }, currentTarget: nativeSelectRef.current });
    close(true);
  };
  const handleKeyDown = event => {
    if (disabled) return;
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { close(); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setKeyboardNavigation(true);
      if (!open) { show(event.key === "ArrowUp" || event.key === "End"); return; }
      const at = enabledIndexes.indexOf(activeIndex);
      const next = event.key === "Home" ? enabledIndexes[0] : event.key === "End" ? enabledIndexes.at(-1)
        : enabledIndexes[(at + (event.key === "ArrowDown" ? 1 : -1) + enabledIndexes.length) % enabledIndexes.length];
      setActiveIndex(next ?? -1); return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setKeyboardNavigation(true);
      if (!open) show(); else if (activeIndex >= 0 && !parsedOptions[activeIndex]?.disabled) handleSelect(parsedOptions[activeIndex].value);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      setKeyboardNavigation(true);
      const now = Date.now(), text = (now - searchRef.current.at < 700 ? searchRef.current.text : "") + event.key.toLocaleLowerCase();
      searchRef.current = { text, at: now };
      const match = enabledIndexes.find(index => String(parsedOptions[index].label).toLocaleLowerCase().startsWith(text));
      if (match !== undefined) { setActiveIndex(match); setOpen(true); }
    }
  };
  return <div className={`custom-select-container ${open ? "is-open" : ""} ${disabled ? "is-disabled" : ""} ${className}`.trim()}
    ref={containerRef} style={width ? { width } : undefined} onKeyDown={handleKeyDown}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <select ref={nativeSelectRef} id={id ? `${id}-native` : undefined} name={name || id} form={form} value={currentValue ?? ""}
      onChange={event => { if (value === undefined) setInternalValue(event.target.value); onChange?.(event); }} disabled={disabled}
      required={required} aria-hidden="true" tabIndex={-1} className="custom-select-native-hidden"
      onFocus={() => triggerRef.current?.focus()}
      onClick={event => { event.preventDefault(); triggerRef.current?.focus(); show(); }}
      onInvalid={event => { event.preventDefault(); triggerRef.current?.focus(); }}>
      {parsedOptions.map(opt => <option key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>)}
    </select>
    <button ref={triggerRef} type="button" id={triggerId} role="combobox" className={`custom-select-trigger ${open ? "active" : ""}`}
      onClick={() => { setKeyboardNavigation(false); open ? close() : show(); }} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
      aria-label={ariaLabel || (labelledBy || id ? undefined : displayLabel)} aria-labelledby={labelledBy} aria-describedby={describedBy}
      aria-activedescendant={open && activeIndex >= 0 ? `${uid}-option-${activeIndex}` : undefined} aria-required={required}>
      <span className="custom-select-value">{displayLabel}</span><ChevronDown size={14} className={`custom-select-chevron ${open ? "rotated" : ""}`} aria-hidden="true" />
    </button>
    {open && !disabled && <div ref={menuRef} id={listId} popover="manual" className="custom-select-dropdown" style={position || { position: "fixed", left: 0, top: 0, right: "auto", bottom: "auto", margin: 0, minWidth: 0, visibility: "hidden" }}
      role="listbox" aria-label={ariaLabel || displayLabel}>
      <div className="custom-select-options">{parsedOptions.map((opt, index) => {
        const isSelected = index === selectedIndex;
        return <div key={opt.value} id={`${uid}-option-${index}`} data-option-index={index} role="option" aria-selected={isSelected} aria-disabled={opt.disabled}
          className={`custom-select-option ${(keyboardNavigation ? activeIndex === index : isSelected) ? "selected" : ""} ${opt.disabled ? "disabled" : ""}`}
          onPointerMove={() => { setKeyboardNavigation(false); if (!opt.disabled && activeIndex !== index) setActiveIndex(index); }}
          onPointerDown={event => event.preventDefault()} onClick={() => { if (!opt.disabled) handleSelect(opt.value); }}>
          <span className="custom-select-option-label">{opt.label}</span>{isSelected && <Check size={14} className="custom-select-check" aria-hidden="true" />}
        </div>;
      })}</div>
    </div>}
  </div>;
}
export const Select = CustomSelect;
export default CustomSelect;
