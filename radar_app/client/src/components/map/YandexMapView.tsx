import { useEffect, useRef, useState } from "react";

import { getMapSettings } from "../../services/mapSettings";
import { metersPerPixel } from "./scene";
import type { MapView, Scene } from "./scene";

declare global {
    interface Window { ymaps?: any }
}

let loading: Promise<any> | null = null;

// скрипт грузится один раз на страницу; логотип и ссылка «Открыть в Картах» - родные элементы Яндекса, их не скрываем (условия API)
const loadYmaps = (key: string): Promise<any> => {
    loading ??= new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(key)}&lang=ru_RU`;
        script.async = true;
        script.onload = () => window.ymaps.ready(() => resolve(window.ymaps));
        script.onerror = () => { loading = null; reject(new Error("не удалось загрузить скрипт api-maps.yandex.ru")); };
        document.head.appendChild(script);
    });

    return loading;
};

// сдвиг вида снаружи (слежение, фокус), мс: без анимации карта прыгает на каждом обзоре
const PAN_MS = 300;

interface Props {
    base: Scene; // постоянная часть: траектория, кольца, РЛС
    current: Scene; // текущий обзор: отметки, прогнозы, строб
    view: MapView; // масштаб Kendo (плитки 256 px) совпадает с масштабом Яндекса
    onViewChange: (view: MapView) => void;
}

// Яндекс Карты (JavaScript API 2.1, ключ - Map:YandexMapsKey на сервере), обертка как в ggnp.ofd.client
export function YandexMapView({ base, current, view, onViewChange }: Props) {
    const boxRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<any>(null);
    const ymapsRef = useRef<any>(null);
    const baseRef = useRef<any>(null);
    const currentRef = useRef<any>(null);
    const [ready, setReady] = useState(false);
    const [zoom, setZoom] = useState(view.zoom);
    const [error, setError] = useState<string | null>(null);

    // обработчик и исходный вид читаются из ref: карта создается один раз
    const latest = useRef({ view, onViewChange });
    latest.current = { view, onViewChange };

    useEffect(() => {
        let alive = true;
        let map: any = null;

        getMapSettings()
            .then((settings) => {
                if (!settings.yandexMapsKey) throw new Error("ключ не задан (раздел Map:YandexMapsKey в appsettings сервера)");
                return loadYmaps(settings.yandexMapsKey);
            })
            .then((ymaps) => {
                if (!alive || !boxRef.current) return;

                map = new ymaps.Map(boxRef.current, {
                    center: latest.current.view.center,
                    zoom: latest.current.view.zoom,
                    controls: ["zoomControl", "typeSelector"],
                }, { suppressMapOpenBlock: false });

                // наверх уходит только вид, который сменил пользователь: конец сдвига, заданного снаружи, - не его действие
                map.events.add("actionend", () => {
                    setZoom(map.getZoom());
                    const [lat, lon] = map.getCenter();
                    const asked = latest.current.view;
                    if (map.getZoom() === asked.zoom && Math.abs(lat - asked.center[0]) < 1e-6 && Math.abs(lon - asked.center[1]) < 1e-6) return;
                    latest.current.onViewChange({ center: [lat, lon], zoom: map.getZoom() });
                });

                // постоянная часть и текущий обзор - отдельные коллекции: на обзоре пересоздается только вторая
                baseRef.current = new ymaps.GeoObjectCollection();
                currentRef.current = new ymaps.GeoObjectCollection();
                map.geoObjects.add(baseRef.current);
                map.geoObjects.add(currentRef.current);

                ymapsRef.current = ymaps;
                mapRef.current = map;
                setReady(true);
            })
            .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });

        return () => {
            alive = false;
            map?.destroy();
            mapRef.current = null;
            setReady(false);
        };
    }, []);

    // вид меняется снаружи: сдвиг при том же масштабе (слежение за целью, фокус) - плавно, смена масштаба (подгонка) - сразу
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        const [lat, lon] = map.getCenter();
        if (map.getZoom() !== view.zoom) map.setCenter(view.center, view.zoom);
        else if (Math.abs(lat - view.center[0]) > 1e-7 || Math.abs(lon - view.center[1]) > 1e-7) {
            map.setCenter(view.center, view.zoom, { duration: PAN_MS, timingFunction: "ease-out" });
        }
    }, [view, ready]);

    // блок меняет размер вместе с окном
    useEffect(() => {
        if (!boxRef.current) return;

        const observer = new ResizeObserver(() => mapRef.current?.container.fitToViewport());
        observer.observe(boxRef.current);

        return () => observer.disconnect();
    }, []);

    // сцена: круги - в метрах родными кругами Яндекса, точки - кругами с радиусом в метрах под текущий масштаб
    const draw = (collection: any, scene: Scene) => {
        const ymaps = ymapsRef.current;
        if (!ymaps || !collection) return;

        collection.removeAll();

        for (const line of scene.lines) {
            collection.add(new ymaps.Polyline(line.points, {}, {
                strokeColor: line.color,
                strokeWidth: line.width,
                strokeOpacity: line.opacity ?? 1,
                strokeStyle: line.dash ? "dash" : "solid",
                interactivityModel: "default#transparent",
            }));
        }

        for (const circle of scene.circles) {
            collection.add(new ymaps.Circle([circle.center, circle.radius], {}, {
                strokeColor: circle.color,
                strokeWidth: circle.width,
                strokeStyle: circle.dash ? "dash" : "solid",
                fillColor: circle.color,
                fillOpacity: circle.fillOpacity ?? 0,
                interactivityModel: "default#transparent",
            }));
        }

        for (const dot of scene.dots) {
            collection.add(new ymaps.Circle([dot.at, dot.radius * metersPerPixel(dot.at[0], zoom)], {}, {
                strokeColor: dot.stroke ?? dot.color,
                strokeWidth: dot.stroke ? 1.5 : 0.5,
                strokeOpacity: dot.opacity ?? 1,
                fillColor: dot.color,
                fillOpacity: dot.opacity ?? 1,
                interactivityModel: "default#transparent",
            }));
        }
    };

    useEffect(() => { draw(baseRef.current, base); }, [base, ready, zoom]);
    useEffect(() => { draw(currentRef.current, current); }, [current, ready, zoom]);

    return (
        <>
            <div ref={boxRef} style={{ position: "absolute", inset: 0 }} />
            {error && <div className="radar-error radar-map__error">Карта Яндекса не загружена: {error}</div>}
        </>
    );
}
