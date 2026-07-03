// Podcast script format: the prompt rules and the parser live together so they
// can never drift apart. generate.ts and rag.ts pick DUO or SOLO rules from the
// router's podcastMode; tts.ts imports parsePodcastScript.

export type ScriptSegment = { speaker: 'A' | 'B' | 'solo'; text: string }
export type ScriptChapter = { title: string; segmentIndex: number }
export type ParsedScript = { segments: ScriptSegment[]; chapters: ScriptChapter[] }

export const DUO_SCRIPT_RULES = `Write the script following these EXACT formatting rules:
- Two hosts. HOST A is Maya: warm and curious. She opens the show, asks questions, and reacts. HOST B is Sam: calm and knowledgeable. He explains ideas clearly with concrete examples.
- Every spoken line MUST start with "HOST A:" or "HOST B:" at the start of the line.
- Split the conversation into 2 to 4 sections. Before each section, put a line containing only [SECTION] followed by a short section title.
- Open with a short greeting and close with a brief sign-off.
- Plain spoken language only: no markdown, no asterisks, no bullet points, no stage directions, no citation numbers, no filenames.
- Match the requested length. About 150 spoken words equal one minute of audio.`

export const SOLO_SCRIPT_RULES = `Write the script following these EXACT formatting rules:
- A single narrator. Choose the narrator's perspective from the user request: if the user asks to narrate their own journal, notes, or experiences, speak in the first person as the author; if they ask for an overview, explanation, or expert take on documents, speak as a knowledgeable host presenting the material. Never invent hosts, interviewers, or a second voice.
- Write flowing spoken paragraphs with NO speaker tags or names.
- Split the narration into 2 to 4 sections. Before each section, put a line containing only [SECTION] followed by a short section title.
- Open with a brief welcome and close with a short sign-off, keeping the same perspective throughout.
- Plain spoken language only: no markdown, no asterisks, no bullet points, no stage directions, no citation numbers, no filenames.
- Match the requested length. About 150 spoken words equal one minute of audio.`

// [SECTION] Title | [SECTION: Title] | SECTION 1: Title | ## Title
const SECTION_RE = /^(?:\[section\s*:?\s*\]?\s*:?\s*|section\s*\d*\s*:\s*|#{1,4}\s+)(.*?)\]?\s*$/i
// HOST A: | host b - | A: (with optional bold markers), plus the personality names
const SPEAKER_RE = /^(?:host\s+)?([ab])\s*[:\-–]\s*(.*)$/i
const NAME_ALIASES: Record<string, 'A' | 'B'> = { maya: 'A', sam: 'B' }

// Remove markdown decoration and non-speakable artifacts from spoken text
function cleanSpokenText(text: string): string {
  return text
    .replace(/\*\*|__|`/g, '')
    .replace(/\[\d+\]/g, '') // citation markers
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Strip leading markdown decoration so tags like "**HOST A:**" or "- HOST A:" match
function stripLineDecoration(line: string): string {
  return line.replace(/^[\s*_>#-]*\s*/, '').trim()
}

// The model sometimes doubles the tag ("HOST B: HOST B: Hello"), which would be
// read aloud. Strip repeated leading tags, but only when they resolve to the SAME
// speaker, so real text like "HOST A: B - as in the second option" survives.
function stripRepeatedTag(text: string, speaker: 'A' | 'B'): string {
  for (;;) {
    const dup = text.match(SPEAKER_RE)
    if (dup && dup[1].toUpperCase() === speaker) {
      text = dup[2]
      continue
    }
    const name = text.match(/^(\w+)\s*[:\-–]\s*(.*)$/)
    if (name && NAME_ALIASES[name[1].toLowerCase()] === speaker) {
      text = name[2]
      continue
    }
    return text
  }
}

export function parsePodcastScript(script: string): ParsedScript {
  const segments: ScriptSegment[] = []
  const chapters: ScriptChapter[] = []
  const speakersSeen = new Set<string>()

  for (const rawLine of script.split('\n')) {
    const line = stripLineDecoration(rawLine)
    if (!line) continue

    // Raw line checked first so "## Title" headings survive decoration-stripping;
    // stripped line catches bolded variants like "**[SECTION] Title**"
    const sectionMatch = rawLine.trim().match(SECTION_RE) ?? line.match(SECTION_RE)
    if (sectionMatch) {
      const title = cleanSpokenText(sectionMatch[1]) || `Section ${chapters.length + 1}`
      chapters.push({ title, segmentIndex: segments.length })
      continue
    }

    let speaker: 'A' | 'B' | null = null
    let spoken = line
    const tagMatch = line.match(SPEAKER_RE)
    if (tagMatch) {
      speaker = tagMatch[1].toUpperCase() as 'A' | 'B'
      spoken = stripRepeatedTag(tagMatch[2], speaker)
    } else {
      const nameMatch = line.match(/^(\w+)\s*[:\-–]\s*(.*)$/)
      if (nameMatch && NAME_ALIASES[nameMatch[1].toLowerCase()]) {
        speaker = NAME_ALIASES[nameMatch[1].toLowerCase()]
        spoken = stripRepeatedTag(nameMatch[2], speaker)
      }
    }

    const text = cleanSpokenText(spoken)
    if (!text) continue

    if (speaker) speakersSeen.add(speaker)
    const last = segments[segments.length - 1]
    if (speaker === null && last && last.speaker !== 'solo') {
      // Untagged line continues the current tagged speaker; in solo scripts
      // each paragraph stays its own segment (better progress granularity)
      last.text += ` ${text}`
    } else if (last && speaker !== null && last.speaker === speaker) {
      // Consecutive same-speaker lines merge for better prosody
      last.text += ` ${text}`
    } else {
      segments.push({ speaker: speaker ?? 'solo', text })
    }
  }

  // Fewer than 2 distinct speakers means the model ignored the dialogue format
  // (or the user asked for solo). Re-emit everything as solo; chapters survive.
  if (speakersSeen.size < 2) {
    return {
      segments: segments.map((s) => ({ speaker: 'solo' as const, text: s.text })),
      chapters,
    }
  }
  return { segments, chapters }
}
