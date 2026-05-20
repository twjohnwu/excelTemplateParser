/** Lightweight native <select> wrapped with shadcn styling.
 * Avoids pulling in the full @radix-ui/react-select tree for our small use cases.
 */

import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          "flex h-9 w-full appearance-none rounded-md border border-input bg-background px-3 py-1 pr-9 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 opacity-50" />
    </div>
  )
);
Select.displayName = "Select";
