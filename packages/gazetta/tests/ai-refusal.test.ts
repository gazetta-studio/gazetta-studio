/**
 * Unit tests for `ai/refusal.ts` — refusal detection across shared and
 * adapter-specific marker lists, plus the empty/short response case.
 */
import { describe, expect, it } from 'vitest'
import { detectRefusal } from '../src/ai/refusal.js'

describe('detectRefusal', () => {
  describe('shared markers', () => {
    it('detects "I can\'t describe" variants', () => {
      expect(detectRefusal("I can't describe this image.").refused).toBe(true)
      expect(detectRefusal('I cannot describe what is shown.').refused).toBe(true)
      expect(detectRefusal("I'm not able to describe this.").refused).toBe(true)
      expect(detectRefusal('I am not able to describe this.').refused).toBe(true)
    })

    it('detects "I\'m unable to describe" variants', () => {
      expect(detectRefusal("I'm unable to describe this image.").refused).toBe(true)
      expect(detectRefusal('I am unable to describe this image.').refused).toBe(true)
    })

    it('detects "I can\'t provide" variants', () => {
      expect(detectRefusal("I can't provide a description.").refused).toBe(true)
      expect(detectRefusal('I cannot provide a description.').refused).toBe(true)
      expect(detectRefusal("I'm unable to provide that.").refused).toBe(true)
    })

    it('detects "I can\'t help" variants', () => {
      expect(detectRefusal("I can't help with that.").refused).toBe(true)
      expect(detectRefusal('I cannot help with that.').refused).toBe(true)
      expect(detectRefusal("I'm not able to help with this.").refused).toBe(true)
    })

    it('detects "I\'m sorry, but" preamble', () => {
      expect(detectRefusal("I'm sorry, but I cannot complete this task.").refused).toBe(true)
    })

    it('is case-insensitive', () => {
      expect(detectRefusal("I CAN'T DESCRIBE THIS.").refused).toBe(true)
      expect(detectRefusal("i can't describe this.").refused).toBe(true)
      expect(detectRefusal("I Can'T Describe This.").refused).toBe(true)
    })

    it('returns truncated reason text on refusal', () => {
      const longRefusal = "I can't describe this image. " + 'x'.repeat(500)
      const result = detectRefusal(longRefusal)
      expect(result.refused).toBe(true)
      expect(result.reason).not.toBeNull()
      expect(result.reason?.length).toBe(200)
    })
  })

  describe('adapter-specific markers', () => {
    it('detects matches against adapter-specific markers', () => {
      const adapterMarkers = ['this content cannot be processed']
      const result = detectRefusal('This content cannot be processed by our system.', adapterMarkers)
      expect(result.refused).toBe(true)
    })

    it('combines shared and adapter-specific markers', () => {
      const adapterMarkers = ['custom phrase x']
      // Shared marker still matches even with adapter markers passed.
      expect(detectRefusal("I can't describe this.", adapterMarkers).refused).toBe(true)
      // Adapter marker matches.
      expect(detectRefusal('A custom phrase x appears here.', adapterMarkers).refused).toBe(true)
    })

    it('adapter markers are case-insensitive', () => {
      const adapterMarkers = ['Custom Refusal']
      expect(detectRefusal('CUSTOM REFUSAL message.', adapterMarkers).refused).toBe(true)
      expect(detectRefusal('a custom refusal message.', adapterMarkers).refused).toBe(true)
    })

    it('defaults to no adapter markers when not passed', () => {
      // Sanity: a normal description doesn't trip with no markers.
      expect(detectRefusal('Mountain at sunset.').refused).toBe(false)
    })
  })

  describe('empty/short responses', () => {
    it('treats empty string as refusal', () => {
      const result = detectRefusal('')
      expect(result.refused).toBe(true)
      expect(result.reason).toBe('Empty or unusably short response')
    })

    it('treats whitespace-only as refusal', () => {
      const result = detectRefusal('   \n\t  ')
      expect(result.refused).toBe(true)
      expect(result.reason).toBe('Empty or unusably short response')
    })

    it('treats sub-5-char responses as refusal', () => {
      expect(detectRefusal('Cat.').refused).toBe(true)
      expect(detectRefusal('Hi').refused).toBe(true)
    })

    it('accepts 5+ character descriptions', () => {
      // "Trees" is 5 chars; passes the threshold.
      expect(detectRefusal('Trees').refused).toBe(false)
      expect(detectRefusal('A cat.').refused).toBe(false)
    })
  })

  describe('non-refusal text', () => {
    it('returns refused: false for normal descriptions', () => {
      const result = detectRefusal('Mountain peak silhouetted against an orange sunset.')
      expect(result.refused).toBe(false)
      expect(result.reason).toBeNull()
    })

    it('does not false-positive on descriptive text containing "I"', () => {
      expect(detectRefusal('I see a mountain in the distance.').refused).toBe(false)
      expect(detectRefusal('A scenic landscape that I find peaceful, with rolling hills and a lake.').refused).toBe(
        false,
      )
    })

    it('does not false-positive on multilingual descriptions', () => {
      expect(detectRefusal('Coucher de soleil sur les montagnes.').refused).toBe(false)
      expect(detectRefusal('غروب الشمس فوق الجبال').refused).toBe(false)
      expect(detectRefusal('山に沈む夕日').refused).toBe(false)
    })
  })
})
