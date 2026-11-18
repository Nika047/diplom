import { useEffect, useState } from "react";
import type { RefObject } from "react";

// размер блока; меняется вместе с окном
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
    const [size, setSize] = useState({ width: 0, height: 0 });

    useEffect(() => {
        const element = ref.current;
        if (!element) return;

        const observer = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            setSize((prev) => (Math.round(prev.width) === Math.round(width) && Math.round(prev.height) === Math.round(height) ? prev : { width, height }));
        });
        observer.observe(element);

        return () => observer.disconnect();
    }, [ref]);

    return size;
}
