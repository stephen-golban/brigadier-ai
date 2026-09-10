/** One vector master supplies the intro, sidebar and generated platform icons. */
export function BrandMark({
  className = "brand-mark size-8 shrink-0",
}: {
  className?: string;
}) {
  return (
    <img
      className={className}
      src="/brand/spark.svg"
      alt="Brigadier"
      width={32}
      height={32}
    />
  );
}
