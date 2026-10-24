// Helpers for scenes animated with a paused GSAP timeline on plain objects.

/**
 * Sets `item.settle` (seconds) on each item to the end of the last tween on any of its targets:
 * from then on the item never changes again, so it can be painted into a cached layer.
 * @param {any} timeline a GSAP timeline
 * @param {{ targets: object[], settle?: number }[]} items
 */
export function settleTimes(timeline, items) {
  const owner = new Map()
  for (const it of items) {
    it.settle = 0
    for (const t of it.targets) owner.set(t, it)
  }
  for (const tw of timeline.getChildren(true, true, false)) {
    const end = tw.startTime() + tw.duration()
    for (const t of tw.targets()) {
      const it = owner.get(t)
      if (it) it.settle = Math.max(it.settle, end)
    }
  }
  return items
}

/**
 * Splits items into those baked into the cache and those drawn live at time `t`: an item bakes
 * once it has settled and so has every earlier item in its paint group (so paint order holds).
 * @returns {boolean[]}
 */
export function bakedAt(items, t) {
  const blocked = new Set()
  return items.map((it) => {
    const ok = it.settle <= t + 1e-9 && !blocked.has(it.group)
    if (!ok) blocked.add(it.group)
    return ok
  })
}
