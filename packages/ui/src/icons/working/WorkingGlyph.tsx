import { ActivityGlyph } from "./ActivityGlyph";
import { BrainGlyph } from "./BrainGlyph";
import { CancelGlyph } from "./CancelGlyph";
import { ClockGlyph } from "./ClockGlyph";
import { EditGlyph } from "./EditGlyph";
import { FileGlyph } from "./FileGlyph";
import { FolderGlyph } from "./FolderGlyph";
import type { GlyphProps } from "./frame";
import { GridGlyph } from "./GridGlyph";
import { InfoGlyph } from "./InfoGlyph";
import { PluginGlyph } from "./PluginGlyph";
import { SearchGlyph } from "./SearchGlyph";
import { TrashGlyph } from "./TrashGlyph";

import classes from "./WorkingGlyph.module.css";

/*
 * Animated activity variants of the shared 32-unit icons. Split SVG paths into independently
 * animated parts; work-log rows use static icons.
 */
const GLYPHS = {
  activity: ActivityGlyph,
  brain: BrainGlyph,
  search: SearchGlyph,
  edit: EditGlyph,
  file: FileGlyph,
  info: InfoGlyph,
  folder: FolderGlyph,
  grid: GridGlyph,
  clock: ClockGlyph,
  cancel: CancelGlyph,
  trash: TrashGlyph,
  plugin: PluginGlyph,
};

export type WorkingGlyphName = keyof typeof GLYPHS;

/** Whether an animated activity variant exists. */
export function isWorkingGlyph(name: string): name is WorkingGlyphName {
  return Object.hasOwn(GLYPHS, name);
}

interface WorkingGlyphProps extends GlyphProps {
  name: WorkingGlyphName;
}

export function WorkingGlyph(props: WorkingGlyphProps) {
  const { name, class: className } = props;
  const Glyph = GLYPHS[name];
  const glyphClass = className === undefined ? classes.glyph : `${classes.glyph} ${className}`;
  return <Glyph class={glyphClass} />;
}
