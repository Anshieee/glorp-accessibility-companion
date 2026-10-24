'use client';

import React, { useState, FormEvent, KeyboardEvent } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';

interface GlassInputProps {
  onSubmit: (url: string) => void;
  isLoading?: boolean;
  initialValue?: string;
  placeholder?: string;
  className?: string;
}

export const GlassInput: React.FC<GlassInputProps> = ({
  onSubmit,
  isLoading = false,
  initialValue = '',
  placeholder = 'Enter or paste a URL...',
  className = '',
}) => {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e?: FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Please enter a website URL');
      return;
    }
    setError(null);
    onSubmit(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  };

  return (
    <div className={`w-full max-w-2xl mx-auto ${className}`}>
      <form
        onSubmit={handleSubmit}
        role="search"
        aria-label="Audit a website URL"
        className="relative group"
      >
        <div
          className={`
            relative flex items-center justify-between
            w-full h-14 md:h-16 px-5 md:px-6
            rounded-full
            liquid-glass-input
            transition-all duration-300
            ${error ? 'border-red-400/60 ring-1 ring-red-400/40' : 'hover:border-white/40 focus-within:border-white/50 focus-within:ring-2 focus-within:ring-white/20'}
          `}
        >
          <input
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            placeholder={placeholder}
            aria-label="Website URL to audit for accessibility"
            aria-invalid={!!error}
            aria-describedby={error ? 'url-input-error' : undefined}
            className="w-full bg-transparent text-white/95 text-base md:text-lg font-light tracking-wide placeholder:text-white/35 focus:outline-none disabled:opacity-50 pr-4"
          />

          <button
            type="submit"
            disabled={isLoading || !value.trim()}
            aria-label={isLoading ? 'Auditing website' : 'Run accessibility audit'}
            className={`
              flex items-center justify-center
              w-9 h-9 md:w-10 md:h-10
              rounded-full
              flex-shrink-0
              transition-all duration-300
              ${
                isLoading
                  ? 'bg-white/10 text-white cursor-wait'
                  : value.trim()
                  ? 'bg-white/95 text-black hover:bg-white hover:scale-105 active:scale-95 shadow-md shadow-black/30'
                  : 'bg-white/15 text-white/40 cursor-not-allowed'
              }
            `}
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 md:w-5 md:h-5 animate-spin text-white" />
            ) : (
              <ArrowRight className="w-4 h-4 md:w-5 md:h-5 stroke-[2.2]" />
            )}
          </button>
        </div>

        {error && (
          <p
            id="url-input-error"
            role="alert"
            className="absolute left-6 -bottom-6 text-xs text-red-300/90 font-mono tracking-tight"
          >
            {error}
          </p>
        )}
      </form>
    </div>
  );
};

export default GlassInput;
