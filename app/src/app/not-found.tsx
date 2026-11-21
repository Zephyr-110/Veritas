"use client";

import Link from "next/link";
import { StableText, StateBlock } from "@/components/ui";

export default function NotFound() {
  return (
    <StateBlock
      kind="empty"
      title={<StableText k="notFound.title" />}
      body={<StableText k="notFound.body" block />}
      action={
        <Link href="/markets" className="link-accent text-[15px]">
          <StableText k="nav.markets" />
        </Link>
      }
    />
  );
}
