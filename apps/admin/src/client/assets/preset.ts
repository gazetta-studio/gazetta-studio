import { definePreset } from '@primeuix/themes'
import Aura from '@primeuix/themes/aura'

/**
 * Aura with light-mode primary + danger shades that meet WCAG AA (#863).
 *
 * Aura's light primary is emerald-500 and its danger button is red-500;
 * white on either fails AA (2.54:1 and 3.76:1), as does emerald-500 or
 * red-500 used as text on white. Light mode moves one to two shades darker:
 *
 *   primary         emerald-700 (hover 800, active 900)  white on it 5.48:1
 *   danger fill     red-600     (hover 700, active 800)  white on it 4.83:1
 *   danger text     red-700  (text/outlined buttons)     on white 6.47:1
 *
 * Dark mode is unchanged: Aura's dark tokens already pass (5.84–10.35:1).
 * Overrides are token references, so PrimeVue derives hover/focus/border
 * from them — no hex literals here. Used by main.ts AND .storybook/preview.ts
 * so the story gate checks the theme the admin actually ships.
 */
export const adminPreset = definePreset(Aura, {
  semantic: {
    colorScheme: {
      light: {
        primary: {
          color: '{primary.700}',
          contrastColor: '#ffffff',
          hoverColor: '{primary.800}',
          activeColor: '{primary.900}',
        },
      },
    },
  },
  components: {
    button: {
      colorScheme: {
        light: {
          root: {
            danger: {
              background: '{red.600}',
              hoverBackground: '{red.700}',
              activeBackground: '{red.800}',
              borderColor: '{red.600}',
              hoverBorderColor: '{red.700}',
              activeBorderColor: '{red.800}',
              focusRing: { color: '{red.600}', shadow: 'none' },
            },
          },
          outlined: { danger: { color: '{red.700}' } },
          text: { danger: { color: '{red.700}' } },
        },
      },
    },
  },
})
