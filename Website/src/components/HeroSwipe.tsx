/** Hero visual — Coach with the best-practices/mistakes checklists. */
export function HeroSwipe() {
  return (
    <div className="relative mx-auto aspect-square w-full max-w-md">
      <img
        src="/SFF-Email-Coach-Hero.webp"
        alt="Coach flanked by a checklist of 22 best practices and 26 common mistakes"
        className="h-full w-full object-contain drop-shadow-[0_30px_60px_-25px_rgba(5,150,105,0.35)]"
        width={900}
        height={900}
        // This is the page's LCP element (it's what Lighthouse measures against).
        // fetchPriority tells the browser to fetch it ahead of lower-priority
        // requests it would otherwise discover first.
        fetchPriority="high"
      />
    </div>
  )
}
