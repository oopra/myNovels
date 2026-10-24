export type ChapterStatus = 'outline' | 'drafting' | 'revising' | 'done';
export type VersionKind = 'autosave' | 'tagged' | 'restore' | 'accept' | 'import';
export type Provenance = 'human' | 'ai_assisted';
export type InputKind = 'idea' | 'research' | 'line' | 'scene' | 'character_note' | 'critique' | 'source';
export type InputStatus = 'inbox' | 'planned' | 'placed' | 'dropped';
export type BibleKind = 'synopsis' | 'character' | 'world' | 'timeline' | 'voice' | 'corrections';
export type PassName = 'critique' | 'line' | 'voice' | 'continuity' | 'stress' | 'research' | 'place_inputs';
export type ProviderId = 'anthropic' | 'gemini';

export interface Chapter {
  id: number; number: number; slug: string; title: string; status: ChapterStatus;
  body: string; word_count: number; updated_at: string;
  owed?: number; last_review_at?: string | null; version_count?: number;
}
export interface Version {
  id: number; chapter_id: number; body: string; label: string | null; note: string | null;
  created_at: string; updated_at: string; kind: VersionKind; provenance: Provenance;
  parent_version_id: number | null; word_count?: number;
}
export interface Input {
  id: number; title: string; body: string; kind: InputKind; source: string | null;
  status: InputStatus; target_chapter_id: number | null; priority: number;
  created_at: string; updated_at: string; links?: InputLink[];
}
export interface InputLink {
  id: number; input_id: number; chapter_id: number; version_id: number; anchor_text: string; created_at: string;
}
export interface BiblePage {
  id: number; kind: BibleKind; title: string; body: string; updated_at: string;
}
export interface Review {
  id: number; chapter_id: number | null; version_id: number | null; pass: PassName; provider: ProviderId;
  model: string; prompt_version: string; output: string; input_tokens: number; output_tokens: number;
  created_at: string; meta: string | null;
}
export interface NovelInfo { folder: string; title: string; last_opened: string; }
export interface ModelInfo { id: string; name: string; }
export interface Usage { input_tokens: number; output_tokens: number; }

export interface ContextPart { name: string; chars: number; tokens: number; }
export interface ContextPreview {
  system: string; user: string; parts: ContextPart[]; tokens: number; exact: boolean;
  provider: ProviderId; model: string; promptVersion: string;
}

export const PASS_LABELS: Record<PassName, string> = {
  critique: 'Critique', line: 'Line', voice: 'Voice', continuity: 'Continuity',
  stress: 'Stress', research: 'Research', place_inputs: 'Place inputs',
};
export const PASS_DEFAULT_PROVIDER: Record<PassName, ProviderId> = {
  critique: 'anthropic', line: 'anthropic', voice: 'anthropic', continuity: 'gemini',
  stress: 'anthropic', research: 'gemini', place_inputs: 'anthropic',
};
export const INPUT_KINDS: InputKind[] = ['idea', 'research', 'line', 'scene', 'character_note', 'critique', 'source'];
export const BIBLE_KINDS: BibleKind[] = ['synopsis', 'character', 'world', 'timeline', 'voice', 'corrections'];
