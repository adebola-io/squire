export interface MermaidDiagram {
  /** Standalone SVG for each theme, without scripts or external references. */
  light: string;
  dark: string;
  width: number;
  height: number;
  accessibleText: string;
}
