import { describe, it, expect } from 'vitest'
import { parsePodcastScript, podcastLengthLine } from './podcast-script'

const wellFormed = `[SECTION] Welcome
HOST A: Hey everyone, welcome to the show!
HOST B: Great to be here. Today we dig into the documents.
[SECTION] The Big Idea
HOST A: So what stood out to you?
HOST B: Two things, really.
HOST B: First the architecture, then the results.
[SECTION] Wrap Up
HOST A: That is all for today. Thanks for listening!`

describe('parsePodcastScript', () => {
  it('parses a well-formed two-host script with sections', () => {
    const { segments, chapters } = parsePodcastScript(wellFormed)
    expect(chapters.map((c) => c.title)).toEqual(['Welcome', 'The Big Idea', 'Wrap Up'])
    expect(segments[0]).toEqual({ speaker: 'A', text: 'Hey everyone, welcome to the show!' })
    expect(segments.map((s) => s.speaker)).toEqual(['A', 'B', 'A', 'B', 'A'])
    // Consecutive HOST B lines merged into one segment
    expect(segments[3].text).toBe('Two things, really. First the architecture, then the results.')
    // Chapter indexes point at the segment that starts each section
    expect(chapters.map((c) => c.segmentIndex)).toEqual([0, 2, 4])
  })

  it('tolerates bold tags and lowercase', () => {
    const { segments } = parsePodcastScript('**HOST A:** Hello!\nhost b: Hi there.')
    expect(segments.map((s) => s.speaker)).toEqual(['A', 'B'])
    expect(segments[0].text).toBe('Hello!')
  })

  it('maps Maya and Sam name aliases to A and B', () => {
    const { segments } = parsePodcastScript('Maya: Welcome back!\nSam: Glad to be here.')
    expect(segments.map((s) => s.speaker)).toEqual(['A', 'B'])
  })

  it('strips duplicated speaker tags so they are not read aloud', () => {
    const { segments } = parsePodcastScript(
      'HOST A: Welcome!\nHOST B: HOST B: Hello Maya.\nMaya: Maya: Hi Sam.\nHOST B: Sam: Good to be here.'
    )
    expect(segments.map((s) => s.text)).toEqual(['Welcome!', 'Hello Maya.', 'Hi Sam.', 'Good to be here.'])
    expect(segments.map((s) => s.speaker)).toEqual(['A', 'B', 'A', 'B'])
  })

  it('keeps a different-speaker prefix that is real text, not a duplicated tag', () => {
    const { segments } = parsePodcastScript('HOST A: B - as in the second option.\nHOST B: Right.')
    expect(segments[0].text).toBe('B - as in the second option.')
  })

  it('appends untagged continuation lines to the current speaker', () => {
    const { segments } = parsePodcastScript('HOST A: First part.\nAnd the continuation.\nHOST B: Reply.')
    expect(segments).toHaveLength(2)
    expect(segments[0].text).toBe('First part. And the continuation.')
  })

  it('falls back to solo when no speaker tags exist', () => {
    const { segments } = parsePodcastScript('Just a plain paragraph.\n\nAnother paragraph here.')
    expect(segments.map((s) => s.speaker)).toEqual(['solo', 'solo'])
  })

  it('falls back to solo when only one speaker is ever tagged', () => {
    const { segments } = parsePodcastScript('HOST A: I talk alone.\nHOST A: Still just me.')
    expect(segments.every((s) => s.speaker === 'solo')).toBe(true)
  })

  it('recognizes markdown headings and SECTION variants as chapters', () => {
    const { chapters } = parsePodcastScript(
      '## Intro\nHOST A: Hi.\n[SECTION: Middle]\nHOST B: Text.\nSECTION 3: End\nHOST A: Bye.'
    )
    expect(chapters.map((c) => c.title)).toEqual(['Intro', 'Middle', 'End'])
  })

  it('strips citations, markdown and URLs from spoken text', () => {
    const { segments } = parsePodcastScript('HOST A: See **this** [1] at https://example.com now.\nHOST B: Sure.')
    expect(segments[0].text).toBe('See this at now.')
  })

  it('returns empty segments for empty or whitespace input', () => {
    expect(parsePodcastScript('').segments).toHaveLength(0)
    expect(parsePodcastScript('  \n\n  ').segments).toHaveLength(0)
  })

  it('never throws on garbage markdown and yields speakable solo segments', () => {
    const garbage = '# Title\n\n- **bullet** one\n- bullet [2] two\n\n> quote block\n\n```\ncode\n```\n| a | b |'
    const { segments } = parsePodcastScript(garbage)
    expect(segments.length).toBeGreaterThan(0)
    expect(segments.every((s) => s.speaker === 'solo')).toBe(true)
  })
})

describe('podcastLengthLine', () => {
  it('converts requested minutes into a word target', () => {
    expect(podcastLengthLine('/podcast two hosts.\nLength: about 5 minutes.')).toContain('about 5 minutes')
    expect(podcastLengthLine('/podcast two hosts.\nLength: about 5 minutes.')).toContain('about 750 words')
    expect(podcastLengthLine('make it a 10 min episode')).toContain('about 1500 words')
  })

  it('returns empty when no length is mentioned or the value is unreasonable', () => {
    expect(podcastLengthLine('/podcast two hosts discuss my documents')).toBe('')
    expect(podcastLengthLine('Length: 500 minutes')).toBe('')
  })
})
