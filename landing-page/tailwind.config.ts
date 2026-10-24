import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        serifDisplay: ['var(--font-advercase)', 'Instrument Serif', 'Playfair Display', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      colors: {
        glorp: {
          bg: '#050209',
          yellow: '#E8FD00',
          dark: '#0B0713',
          glass: 'rgba(16, 12, 24, 0.42)',
          'glass-border': 'rgba(255, 255, 255, 0.22)',
          'glass-highlight': 'rgba(255, 255, 255, 0.18)',
          text: '#F3F2F7',
          muted: '#8D899B',
          subtle: 'rgba(255, 255, 255, 0.08)',
        },
      },
      boxShadow: {
        'liquid-glass': 'inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 16px 48px -8px rgba(0, 0, 0, 0.55)',
        'liquid-input': 'inset 0 1px 0 rgba(255, 255, 255, 0.2), inset 0 -1px 0 rgba(0, 0, 0, 0.3), 0 12px 40px rgba(0, 0, 0, 0.4)',
        'yellow-glow': '0 0 25px rgba(232, 253, 0, 0.35)',
      },
      animation: {
        'fade-in': 'fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-up': 'slideUp 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'pulse-subtle': 'pulseSubtle 3s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'scale(0.98)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
