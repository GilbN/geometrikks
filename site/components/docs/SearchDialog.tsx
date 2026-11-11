"use client";

import { useFlexsearchStatic } from "fumadocs-core/search/client/flexsearch-static";
import { useOnChange } from "fumadocs-core/utils/use-on-change";
import {
  SearchDialog as Dialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
  TagsList,
  TagsListItem,
} from "fumadocs-ui/components/dialog/search";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { versionOfUrl } from "@/lib/versions";

export type SearchDialogProps = SharedProps & { latestServed: boolean };

export default function SearchDialog({ latestServed, ...props }: SearchDialogProps) {
  const pageTag = versionOfUrl(usePathname());
  const [tag, setTag] = useState<string | undefined>(pageTag);
  useOnChange(pageTag, setTag);
  const search = useFlexsearchStatic({ tag });

  return (
    <Dialog {...search} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList />
        <SearchDialogFooter>
          <TagsList tag={tag} onTagChange={setTag}>
            {latestServed && <TagsListItem value="latest">Latest</TagsListItem>}
            <TagsListItem value="next">Next</TagsListItem>
          </TagsList>
        </SearchDialogFooter>
      </SearchDialogContent>
    </Dialog>
  );
}
