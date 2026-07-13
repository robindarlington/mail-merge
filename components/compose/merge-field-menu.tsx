"use client";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";

/**
 * MergeFieldMenu — the zero-dependency merge-field affordance for the compose
 * editor (EDIT-02). Two ways to insert a `{{column}}` token, both driven by the
 * parent editor which owns the focused field + caret:
 *
 *   1. Click-to-insert CHIPS — one `secondary` Button per CSV column; clicking
 *      calls `onInsertChip(column)` and the editor splices `{{column}}` at the
 *      last-focused field's caret.
 *   2. `{{`-triggered SUGGESTION LIST — a fixed-position `Popover` (anchored to
 *      the chip row, NOT to caret pixels) the editor opens when the text right
 *      before the caret matches `{{partial`. This component is presentational:
 *      it renders the pre-filtered `matches`, and selecting one (mousedown, so
 *      the field never blurs) calls `onSelect(column)`. An empty match set shows
 *      "No matching fields." (04-UI-SPEC line 121).
 *
 * NO command-palette dependency and NO caret-pixel geometry (04-RESEARCH.md A1 /
 * Don't-Hand-Roll): column names render as auto-escaped JSX text and are inserted
 * as literal `{{name}}` text, never as HTML (T-4-XSS-CHIP).
 */

interface MergeFieldMenuProps {
  /** All CSV columns for the selected recipient list — the chip set. */
  columns: string[];
  /** Insert `{{column}}` at the editor's last-focused caret (chip click). */
  onInsertChip: (column: string) => void;
  /** Whether the `{{`-triggered suggestion popover is open. */
  open: boolean;
  /** The columns matching the partial token the user is typing after `{{`. */
  matches: string[];
  /** Radix open-change (outside click / escape) — the editor clears its state. */
  onOpenChange: (open: boolean) => void;
  /** Choose a suggestion — the editor replaces the `{{partial` with `{{column}}`. */
  onSelect: (column: string) => void;
}

export function MergeFieldMenu({
  columns,
  onInsertChip,
  open,
  matches,
  onOpenChange,
  onSelect,
}: MergeFieldMenuProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Merge fields</span>
          <p className="text-sm text-muted-foreground">
            {`Click a field to insert it, or type {{ in the subject or message.`}
          </p>
          <div className="flex flex-wrap gap-2">
            {columns.map((column) => (
              <Button
                key={column}
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onInsertChip(column)}
              >
                {column}
              </Button>
            ))}
          </div>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-64 gap-1 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {matches.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            No matching fields.
          </p>
        ) : (
          <ul className="flex flex-col">
            {matches.map((column) => (
              <li key={column}>
                <button
                  type="button"
                  // mousedown (not click) + preventDefault keeps focus in the
                  // field so the caret splice targets the right spot.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(column);
                  }}
                  className="flex w-full cursor-default items-center rounded-md px-2 py-1.5 text-left text-sm outline-none select-none hover:bg-muted hover:text-foreground"
                >
                  {column}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
