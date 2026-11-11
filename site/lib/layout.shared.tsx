import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Mark } from "@/components/brand/Mark";
import { Wordmark } from "@/components/brand/Wordmark";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <Mark size={24} />
          <Wordmark className="text-[15px]" />
        </>
      ),
    },
    githubUrl: "https://github.com/GilbN/geometrikks",
  };
}
