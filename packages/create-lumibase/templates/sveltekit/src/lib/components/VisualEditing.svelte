<!--
  Visual editing hook point — intentionally renders nothing today.

  LumiBase visual editing (roadmap V03, issue #681, a future
  `@lumibase/visual-editing` package) does not exist yet. When it ships, its
  overlay is mounted HERE, and only for verified preview sessions: the root
  layout renders this component only when `data.preview` is true, so ordinary
  visitors never load editing code.

  Until then there is deliberately no placeholder script, no data attributes
  and no invented API — just this one place to plug it in.
-->
