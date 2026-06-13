import React from 'react';

export interface InterfaceProps<T> {
  value: T | null;
  onChange: (value: T | null) => void;
  disabled?: boolean;
  options?: Record<string, any>;
}

export default function ColorPickerInterface({
  value,
  onChange,
  disabled = false,
  options = {},
}: InterfaceProps<string>) {
  const colorValue = value ?? options.defaultColor ?? '#000000';

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    // Basic hex code validation
    if (/^#[0-9A-F]{6}$/i.test(val)) {
      onChange(val);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(colorValue);
  };

  return (
    <div style={styles.container}>
      <div style={styles.colorWrapper}>
        <input
          type="color"
          value={colorValue}
          onChange={handleColorChange}
          disabled={disabled}
          style={styles.colorInput}
        />
        <div 
          style={{ 
            ...styles.colorPreview, 
            backgroundColor: colorValue 
          }} 
        />
      </div>

      <input
        type="text"
        value={colorValue.toUpperCase()}
        onChange={handleHexChange}
        disabled={disabled}
        placeholder="#000000"
        maxLength={7}
        style={styles.textInput}
      />

      <button
        type="button"
        onClick={handleCopy}
        style={styles.button}
        title="Copy color hex"
      >
        Copy
      </button>

      {!disabled && value && (
        <button
          type="button"
          onClick={() => onChange(null)}
          style={{ ...styles.button, ...styles.clearButton }}
        >
          Clear
        </button>
      )}
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  colorWrapper: {
    position: 'relative' as const,
    width: '40px',
    height: '40px',
    borderRadius: '8px',
    overflow: 'hidden',
    border: '1px solid #e2e8f0',
  },
  colorInput: {
    position: 'absolute' as const,
    top: '-5px',
    left: '-5px',
    width: '50px',
    height: '50px',
    cursor: 'pointer',
    opacity: 0,
  },
  colorPreview: {
    width: '100%',
    height: '100%',
    pointerEvents: 'none' as const,
  },
  textInput: {
    flex: 1,
    height: '40px',
    padding: '0 12px',
    borderRadius: '8px',
    border: '1px solid #e2e8f0',
    fontSize: '14px',
    fontWeight: 500,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  button: {
    height: '40px',
    padding: '0 16px',
    borderRadius: '8px',
    border: '1px solid #e2e8f0',
    backgroundColor: '#fff',
    color: '#0f172a',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.1s ease',
  },
  clearButton: {
    backgroundColor: '#fef2f2',
    borderColor: '#fee2e2',
    color: '#ef4444',
  },
};
