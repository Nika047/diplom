// сцена карты - то, что рисуется, без привязки к подложке: Kendo Map (OpenStreetMap и плоскость) и Яндекс рисуют одну сцену.
// координаты - [широта, долгота]; на плоскости это метры относительно РЛС, переведенные в градусы у экватора (planeLatLon)

export type LatLon = [number, number];

export interface SceneLine {
    points: LatLon[];
    color: string;
    width: number;
    dash?: boolean;
    opacity?: number;
}

// круг радиусом в метрах (строб, кольца дальности)
export interface SceneCircle {
    center: LatLon;
    radius: number;
    color: string;
    width: number;
    dash?: boolean;
    fillOpacity?: number;
}

// точка радиусом в пикселях
export interface SceneDot {
    at: LatLon;
    radius: number;
    color: string;
    stroke?: string;
    opacity?: number;
}

export interface Scene {
    lines: SceneLine[];
    circles: SceneCircle[];
    dots: SceneDot[];
}

export const emptyScene = (): Scene => ({ lines: [], circles: [], dots: [] });

// метров в градусе широты; у экватора и в градусе долготы
export const M_PER_DEG = 111_320;

// плоскость: e, n (м) относительно РЛС -> «широта, долгота» у экватора, где проекция Меркатора почти не искажает
// расстояния (на 10 км - доли процента)
export const planeLatLon = (e: number, n: number): LatLon => [n / M_PER_DEG, e / M_PER_DEG];

export const circlePolygon = (center: LatLon, radius: number, steps = 72): LatLon[] => {
    const cos = Math.cos(center[0] * Math.PI / 180);
    const points: LatLon[] = [];

    for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * 2 * Math.PI;
        points.push([center[0] + radius * Math.sin(a) / M_PER_DEG, center[1] + radius * Math.cos(a) / (M_PER_DEG * cos)]);
    }

    return points;
};

// метров в пикселе плиток 256 px на масштабе zoom
export const metersPerPixel = (lat: number, zoom: number): number =>
    156_543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);

export interface MapView {
    center: LatLon;
    zoom: number;
}

const mercatorY = (lat: number): number => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

// все точки сцены (линии, точки, края кругов) - для подгонки вида под нее
export const sceneExtent = (scene: Scene): LatLon[] => [
    ...scene.lines.flatMap((l) => l.points),
    ...scene.dots.map((d) => d.at),
    ...scene.circles.flatMap((c) => {
        const dLat = c.radius / M_PER_DEG;
        const dLon = c.radius / (M_PER_DEG * Math.cos(c.center[0] * Math.PI / 180));
        return [[c.center[0] - dLat, c.center[1] - dLon], [c.center[0] + dLat, c.center[1] + dLon]] as LatLon[];
    }),
];

// центр и масштаб, при которых точки занимают окно width x height с полями
export const fitView = (points: LatLon[], width: number, height: number): MapView => {
    if (!points.length || width <= 0 || height <= 0) return { center: [0, 0], zoom: 12 };

    const lats = points.map((p) => p[0]);
    const lons = points.map((p) => p[1]);
    const [minLat, maxLat, minLon, maxLon] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];

    const spanX = Math.max((maxLon - minLon) * Math.PI / 180, 1e-7);
    const spanY = Math.max(mercatorY(maxLat) - mercatorY(minLat), 1e-7);
    const zx = Math.log2(width * 0.85 * 2 * Math.PI / (256 * spanX));
    const zy = Math.log2(height * 0.85 * 2 * Math.PI / (256 * spanY));

    return {
        center: [(minLat + maxLat) / 2, (minLon + maxLon) / 2],
        zoom: Math.max(2, Math.min(18, Math.floor(Math.min(zx, zy)))),
    };
};
