import { PROVIDER_ICON_MARKUP, PROVIDER_ICON_MARKS } from "../../providerIcons.js";

interface Props {
  provider: string;
  className?: string;
}

/** Shared provider marks used by the sidebar and analytics surfaces. */
export function ProviderLogo({ provider, className = "" }: Props) {
  const classes = `provider-logo provider-logo--${provider} ${className}`.trim();
  const markup = PROVIDER_ICON_MARKUP[provider as keyof typeof PROVIDER_ICON_MARKUP];

  if (markup) {
    return <span class={classes} aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} />;
  }

  return <span class={classes} aria-hidden="true">{PROVIDER_ICON_MARKS[provider as keyof typeof PROVIDER_ICON_MARKS] || "✦"}</span>;
}

