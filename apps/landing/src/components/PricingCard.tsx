import { Check, X } from "lucide-react";

interface PricingCardProps {
  name: string;
  price: number;
  period: string;
  description: string;
  features: string[];
  unavailableFeatures?: string[];
  popular?: boolean;
  ctaText: string;
  ctaLink: string;
}

export default function PricingCard({
  name,
  price,
  period,
  description,
  features,
  unavailableFeatures = [],
  popular = false,
  ctaText,
  ctaLink,
}: PricingCardProps) {
  return (
    <div
      className={`relative rounded-2xl border p-8 transition-colors ${
        popular
          ? "border-signal-500/60 bg-ink-900"
          : "border-ink-700 bg-ink-900 hover:border-ink-600"
      }`}
    >
      {popular && (
        <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
          <span className="inline-flex items-center rounded-full bg-signal-500 px-4 py-1 font-mono text-xs font-semibold uppercase tracking-wide text-ink-950">
            Most Popular
          </span>
        </div>
      )}

      <h3 className="font-mono text-xl font-semibold text-foreground">{name}</h3>
      <p className="mt-2 text-sm text-gray-500">{description}</p>

      <div className="mt-6 flex items-baseline gap-1">
        <span className="text-4xl font-bold text-foreground">${price}</span>
        <span className="text-gray-500">/{period}</span>
      </div>

      <ul className="mt-8 space-y-3.5">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-3">
            <Check className="mt-0.5 h-5 w-5 flex-shrink-0 text-signal-400" />
            <span className="text-sm text-gray-300">{feature}</span>
          </li>
        ))}
        {unavailableFeatures.map((feature) => (
          <li key={feature} className="flex items-start gap-3">
            <X className="mt-0.5 h-5 w-5 flex-shrink-0 text-gray-600" />
            <span className="text-sm text-gray-600 line-through">{feature}</span>
          </li>
        ))}
      </ul>

      <a
        href={ctaLink}
        target="_blank"
        rel="noopener noreferrer"
        className={`mt-8 block w-full rounded-md px-6 py-3 text-center text-sm font-semibold transition-colors ${
          popular
            ? "bg-signal-500 text-ink-950 hover:bg-signal-400"
            : "border border-ink-600 text-gray-200 hover:border-signal-500/50 hover:text-signal-400"
        }`}
      >
        {ctaText}
      </a>
    </div>
  );
}
