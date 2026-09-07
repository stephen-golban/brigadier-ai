/** One vector master supplies the intro, sidebar and generated platform icons. */
export function BrandMark({
  className = "brand-mark",
}: {
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 256 256"
      role="img"
      aria-label="Brigadier"
    >
      <use href="/brand/fold.svg#mark" />
    </svg>
  );
}
