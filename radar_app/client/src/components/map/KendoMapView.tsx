import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { MutableRefObject } from "react";

import { Circle as DrawingCircle, geometry } from "@progress/kendo-drawing";
import { Map as KendoMap, MapLayers, MapTileLayer, MapShapeLayer, MapBubbleLayer } from "@progress/kendo-react-map";
import type { ShapeCreatedEvent, TileUrlTemplateArgs } from "@progress/kendo-react-map";

import { osmTileUrl } from "../../data/settings";
import { circlePolygon } from "./scene";
import type { LatLon, MapView, Scene, SceneDot } from "./scene";

const tileSubdomains = ["a", "b", "c"];

const tileUrl = (e: TileUrlTemplateArgs) => osmTileUrl
    .replace("{s}", e.subdomain).replace("{z}", String(e.zoom)).replace("{x}", String(e.x)).replace("{y}", String(e.y));

const MAP_STYLE = { height: "100%", width: "100%" };

// данные слоев текущего обзора при создании карты: дальше их задает applyCurrent напрямую
const EMPTY: never[] = [];

// стиль линии или круга - в свойствах объекта GeoJSON, слой красит его в onShapeCreated
interface ShapeStyle {
    color: string;
    width: number;
    dash?: boolean;
    opacity?: number;
    fillOpacity?: number;
}

const toLonLat = (points: LatLon[]) => points.map((p) => [p[1], p[0]]);

const shapeFeatures = (scene: Scene) => [
    ...scene.lines.map((l) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: toLonLat(l.points) },
        properties: { color: l.color, width: l.width, dash: l.dash, opacity: l.opacity } as ShapeStyle,
    })),
    ...scene.circles.map((c) => ({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [toLonLat(circlePolygon(c.center, c.radius))] },
        properties: { color: c.color, width: c.width, dash: c.dash, fillOpacity: c.fillOpacity ?? 0 } as ShapeStyle,
    })),
];

// значение пузыря слою обязательно, размер задает dotSymbol
const dotItems = (scene: Scene) => scene.dots.map((d) => ({ ...d, size: 1 }));

// значок точки: кружок радиусом в пикселях
const dotSymbol = (e: { center: geometry.Point; dataItem: SceneDot }) => new DrawingCircle(new geometry.Circle(e.center, e.dataItem.radius), {
    fill: { color: e.dataItem.color, opacity: e.dataItem.opacity ?? 1 },
    stroke: { color: e.dataItem.stroke ?? e.dataItem.color, width: e.dataItem.stroke ? 1.5 : 0.5, opacity: e.dataItem.opacity ?? 1 },
});

const paintShape = (e: ShapeCreatedEvent) => {
    const shape = e.shape as unknown as {
        dataItem?: { properties?: ShapeStyle };
        stroke: (color: string, width: number, opacity: number) => void;
        fill: (color: string, opacity: number) => void;
        options: { set: (field: string, value: unknown) => void };
    };
    const style = shape.dataItem?.properties;
    if (!style) return;

    shape.stroke(style.color, style.width, style.opacity ?? 1);
    shape.options.set("stroke.dashType", style.dash ? "dash" : "solid");
    shape.fill(style.color, style.fillOpacity ?? 0);
};

interface Current {
    shapes: unknown[];
    dots: unknown[];
}

// плавный сдвиг вида: постоянная времени, мс (за 3 постоянных карта проходит 95% пути)
const GLIDE_TAU_MS = 160;

// дальше этой доли окна сдвиг не анимируется: вид ставится сразу
const GLIDE_MAX = 1.5;

// сдвиг вида без сброса карты: положение блока прокрутки (px, дробное), цель и кадр анимации
interface Glide {
    scroller: any;
    x: number;
    y: number;
    tx: number;
    ty: number;
    sx: number; // положение блока после нашего шага: изменилось - карту сдвинул кто-то еще (пользователь, сброс)
    sy: number;
    frame: number | null;
    last: number;
    dirty: boolean; // слои еще не подогнаны под сдвиг
}

const glides = new WeakMap<object, Glide>();

const stopGlide = (map: any) => {
    const g = map ? glides.get(map) : undefined;
    if (!g) return;
    if (g.frame != null) cancelAnimationFrame(g.frame);
    glides.delete(map);
};

// слои после сдвига: поверхности фигур - под новый вид, плитки - дорисовать. То же, что Kendo делает по panEnd, но без
// события: оно ушло бы в onViewChange как сдвиг пользователя
const settleGlide = (map: any) => {
    const g = glides.get(map);
    if (!g?.dirty) return;

    g.dirty = false;
    for (const layer of map.layers ?? []) layer._panEnd?.({});
};

const glideStep = (map: any, now: number) => {
    const g = glides.get(map);
    if (!g) return;

    g.frame = null;
    const movable = map.scroller?.movable;
    if (map.scroller !== g.scroller || !movable || movable.x !== g.sx || movable.y !== g.sy) {
        glides.delete(map);
        return;
    }

    const a = 1 - Math.exp(-Math.min(now - g.last, 100) / GLIDE_TAU_MS);
    g.last = now;
    g.x += (g.tx - g.x) * a;
    g.y += (g.ty - g.y) * a;

    const done = Math.abs(g.tx - g.x) < 0.5 && Math.abs(g.ty - g.y) < 0.5;
    if (done) {
        g.x = g.tx;
        g.y = g.ty;
    }

    g.scroller.scrollTo(g.x, g.y);
    g.sx = movable.x;
    g.sy = movable.y;
    g.dirty = true;

    if (done) {
        settleGlide(map);
        glides.delete(map);
        return;
    }

    // поверхности фигур размером с окно: без подгонки на каждом кадре край, куда едет карта, пуст до конца сдвига
    for (const layer of map.layers ?? []) layer._translateSurface?.();
    g.frame = requestAnimationFrame((t) => glideStep(map, t));
};

// центр вида - плавно, прокруткой карты, как при перетаскивании мышью: map.center() сбрасывает карту (плитки и все слои
// создаются заново), на каждом обзоре это моргание. false - сдвиг слишком далекий или прокрутки нет: ставить вид сразу
const glideTo = (map: any, center: LatLon): boolean => {
    const scroller = map.scroller;
    const movable = scroller?.movable;
    if (!movable || scroller._native) return false;

    const size = map.viewSize();
    const p = map.locationToView(center);
    // целые пиксели: на дробном положении плитки и линии в покое размыты
    const tx = Math.round(size.width / 2 - p.x);
    const ty = Math.round(size.height / 2 - p.y);

    let g = glides.get(map);
    if (g && (g.scroller !== scroller || movable.x !== g.sx || movable.y !== g.sy)) {
        stopGlide(map);
        g = undefined;
    }

    const x = g?.x ?? movable.x;
    const y = g?.y ?? movable.y;
    if (Math.abs(tx - x) > size.width * GLIDE_MAX || Math.abs(ty - y) > size.height * GLIDE_MAX) {
        stopGlide(map);
        return false;
    }
    if (!g && Math.abs(tx - x) < 1 && Math.abs(ty - y) < 1) return true;

    if (!g) {
        g = { scroller, x, y, tx, ty, sx: movable.x, sy: movable.y, frame: null, last: 0, dirty: false };
        glides.set(map, g);
    }
    g.tx = tx;
    g.ty = ty;

    if (g.frame == null) {
        g.last = performance.now();
        g.frame = requestAnimationFrame((t) => glideStep(map, t));
    }

    return true;
};

// слои текущего обзора - последние у карты: фигуры, затем точки
const applyCurrent = (map: any, current: Current) => {
    const layers = map?.layers;
    if (!layers || layers.length < 2) return;

    settleGlide(map);

    const shapes = layers[layers.length - 2];
    const dots = layers[layers.length - 1];
    shapes.options.data = current.shapes;
    shapes.reset();
    dots.options.data = current.dots;
    dots.reset();
};

const applyView = (map: any, view: MapView) => {
    if (!map) return;

    if (view.zoom !== map.zoom()) {
        stopGlide(map);
        map.zoom(view.zoom);
    }
    else if (glideTo(map, view.center)) return;

    const c = map.center();
    if (Math.abs(c.lat - view.center[0]) > 1e-9 || Math.abs(c.lng - view.center[1]) > 1e-9) map.center(view.center);
};

interface InnerProps {
    baseShapes: unknown[];
    baseDots: unknown[];
    tiles: boolean;
    kendoRef: MutableRefObject<any>;
    viewRef: MutableRefObject<MapView>;
    currentRef: MutableRefObject<Current>;
    onViewChange: (view: MapView) => void;
}

// сама карта с постоянными слоями: перерисовывается React только при смене постоянной части (подложка, слои истины).
// Kendo React Map на любое изменение сбрасывает список слоев и пересоздает карту (setOptions), это сотни мс,
// поэтому текущий обзор и вид сюда не передаются, а задаются у экземпляра карты (applyCurrent, applyView, glideTo)
const InnerMap = memo(function InnerMap({ baseShapes, baseDots, tiles, kendoRef, viewRef, currentRef, onViewChange }: InnerProps) {
    // полное обновление (смена постоянной части): вид и текущий обзор - актуальные, а не те, что были при создании
    const refresh = useCallback((options: any, map: any) => {
        stopGlide(map);
        map.setOptions({ ...options, center: viewRef.current.center, zoom: viewRef.current.zoom });
        applyCurrent(map, currentRef.current);
    }, [viewRef, currentRef]);

    // вид после сдвига и масштаба - у экземпляра карты, как в ggnp.ofd.client (StationsMap)
    const remember = useCallback((e: { target: { mapInstance: any } }) => {
        const map = e.target.mapInstance;
        if (!map) return;

        const c = map.center();
        viewRef.current = { center: [c.lat, c.lng], zoom: map.zoom() };
        onViewChange(viewRef.current);
    }, [onViewChange, viewRef]);

    return (
        <KendoMap
            ref={kendoRef}
            center={viewRef.current.center}
            zoom={viewRef.current.zoom}
            style={MAP_STYLE}
            onZoomEnd={remember as never}
            onPanEnd={remember as never}
            onShapeCreated={paintShape}
            onRefresh={refresh}
        >
            <MapLayers>
                {[
                    ...(tiles ? [<MapTileLayer key="tiles" urlTemplate={tileUrl} subdomains={tileSubdomains}
                        attribution="&copy; OpenStreetMap" />] : []),
                    <MapShapeLayer key="base-shapes" data={baseShapes} />,
                    <MapBubbleLayer key="base-dots" data={baseDots} locationField="at" valueField="size" symbol={dotSymbol as never} />,
                    <MapShapeLayer key="current-shapes" data={EMPTY} />,
                    <MapBubbleLayer key="current-dots" data={EMPTY} locationField="at" valueField="size" symbol={dotSymbol as never} />,
                ]}
            </MapLayers>
        </KendoMap>
    );
});

interface Props {
    base: Scene; // постоянная часть: траектория, кольца, РЛС
    current: Scene; // текущий обзор: отметки, прогнозы, строб
    view: MapView;
    tiles: boolean; // OpenStreetMap; без плиток - плоскость
    onViewChange: (view: MapView) => void;
}

// Kendo Map: плитки OpenStreetMap или пустой фон (плоскость); линии и круги - слои GeoJSON, точки - слои пузырей
export const KendoMapView = memo(function KendoMapView({ base, current, view, tiles, onViewChange }: Props) {
    const baseShapes = useMemo(() => shapeFeatures(base), [base]);
    const baseDots = useMemo(() => dotItems(base), [base]);

    const kendoRef = useRef<any>(null);
    const viewRef = useRef<MapView>(view);
    const currentRef = useRef<Current>({ shapes: [], dots: [] });

    // новый обзор: перезагружаются только два слоя текущего обзора
    useEffect(() => {
        currentRef.current = { shapes: shapeFeatures(current), dots: dotItems(current) };
        applyCurrent(kendoRef.current?.mapInstance, currentRef.current);
    }, [current]);

    // вид снаружи (подгонка, слежение за целью): центр - плавным сдвигом, масштаб и далекий переход - сбросом карты
    const glidingRef = useRef<any>(null);
    useEffect(() => {
        viewRef.current = view;
        glidingRef.current = kendoRef.current?.mapInstance ?? null;
        applyView(glidingRef.current, view);
    }, [view]);

    useEffect(() => () => stopGlide(glidingRef.current), []);

    return <InnerMap baseShapes={baseShapes} baseDots={baseDots} tiles={tiles} kendoRef={kendoRef} viewRef={viewRef}
        currentRef={currentRef} onViewChange={onViewChange} />;
});
