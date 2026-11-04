"use client";

import { Loader2 } from "lucide-react";
import { Banner, FlowCanvas, Problems, ReferentsProvider, ValidityNotice } from "story-view";

import { trpc } from "@/lib/trpc";

/**
 * The story view: the same automation, told rather than coded.
 *
 * ONE rendering. The canvas WAS the flow the moment record edges folded into
 * the cards, and the numbered list beside it said the same thing again in
 * worse words — so it is gone, and everything a reader needs is on the canvas.
 *
 * This file is the WORKBENCH MOUNT: it fetches the saved movement's view and
 * frames it in the editor's chrome. The drawing itself lives in `story-view`,
 * which the standalone story page mounts too — one renderer, two mounts.
 *
 * Honesty is the rule the page is built around. It always shows the script's
 * standing, and a script we couldn't read produces no picture at all —
 * a plausible-looking diagram of a program nobody checked is worse than none.
 *
 */
export function MovementStory({
  movementId,
  unsavedEdits,
}: {
  movementId: string;
  unsavedEdits?: boolean;
}) {
  const { data, isLoading, error } = trpc.views.movement.story.useQuery(
    { id: movementId },
    { refetchOnWindowFocus: false, refetchOnMount: "always" },
  );

  if (isLoading) {
    return (
      <Centered>
        <Loader2 size={15} className="mr-2 animate-spin" />
        Reading your script…
      </Centered>
    );
  }

  if (error || !data) {
    return <Centered>This automation couldn’t be loaded.</Centered>;
  }

  if (!data.ok) {
    return (
      <div className="h-full overflow-y-auto px-6 py-5">
        {unsavedEdits && <UnsavedNotice />}
        <Banner tone="stop" title="We can’t show this one yet">
          There’s a problem in the script itself, so there’s nothing safe to
          show — switch to the code to fix it.
        </Banner>
        <Problems problems={data.problems} />
      </div>
    );
  }

  const { view } = data;

  return (
    // Both renderings read the same referent vocabulary, so the picture and the
    // words cannot disagree about what a name stands for.
    <ReferentsProvider view={view}>
      {/* The pane does not scroll: the notices and the heading hold their place
          and the BOARD takes the rest of the height, scrolling inside itself on
          both axes. One scroller under the pointer, wherever the pointer is. */}
      <div className="flex h-full min-h-0 flex-col px-6 py-5">
        <div className="shrink-0">
          {unsavedEdits && <UnsavedNotice />}
          <ValidityNotice validity={view.movement.validity} />

          <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-gray-400">
            How it runs
          </h3>
        </div>
        <div className="mt-4 min-h-0 flex-1">
          <FlowCanvas view={view} />
        </div>
      </div>
    </ReferentsProvider>
  );
}

/** The story is of the SAVED script. Saying so is the whole honesty rule
 *  applied to the one case the page cannot see: your unsaved draft. */
function UnsavedNotice() {
  return (
    <Banner tone="warn" title="You have changes that aren’t saved">
      This is the last saved version — save to see your edits here.
    </Banner>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-gray-400">
      {children}
    </div>
  );
}
