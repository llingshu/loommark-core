// Editor option types shared by every host. These describe *what the editor renders like*, not
// how a particular host talks to it — contrast with a host's own wire protocol (e.g. LoomMark's
// VS Code extension has its own HostToWebview/WebviewToHost postMessage types that wrap these).

export type EditorTheme = 'vscode' | 'crepe' | 'frame' | 'nord';
export type OutlineMode = 'both' | 'editor' | 'explorer' | 'off';
export type TableMode = 'rich' | 'source';
export type TableStyle = 'grid' | 'ruled';
export type OrderedListStyle = 'decimal' | 'cycle';

// off: no heading visualization. tint: soft background wash only, no borders. accent: a colored
// left border bar per level plus a faint tint. card: bordered, independently rounded nested
// sections drawn with line decorations and boundary widgets.
export type CardMode = 'off' | 'tint' | 'accent' | 'card';
export const CARD_MODE_ORDER: readonly CardMode[] = ['off', 'tint', 'accent', 'card'];

export type BackgroundConfiguration = {
  enabled: boolean;
  imageUri?: string;
  opacity: number;
  blur: number;
  saturation: number;
  overlay: number;
  status: 'disabled' | 'loaded' | 'missing' | 'empty' | 'error';
  detail?: string;
};

export type CardImageConfiguration = {
  enabled: boolean;
  imageUris: string[];
  opacity: number;
  blur: number;
  saturation: number;
  overlay: number;
  status: 'disabled' | 'loaded' | 'missing' | 'empty' | 'error';
  detail?: string;
};

export type EditorConfiguration = {
  syncDelay: number;
  theme: EditorTheme;
  outline: OutlineMode;
  table: TableMode;
  tableStyle: TableStyle;
  orderedListStyle: OrderedListStyle;
  keyboardEditing: boolean;
  listGuides: boolean;
  cardMode: CardMode;
  cardBackgroundColors: string[];
  cardBorderColors: string[];
  cardBackgroundStrength: number;
  cardBorderStrength: number;
  background: BackgroundConfiguration;
  cardImage: CardImageConfiguration;
};
