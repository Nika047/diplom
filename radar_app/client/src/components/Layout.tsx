import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { AppBar, AppBarSection, AppBarSpacer } from "@progress/kendo-react-layout";
import { Button, DropDownButton } from "@progress/kendo-react-buttons";
import { logoutIcon } from "@progress/kendo-svg-icons";

import { useAuthContext } from "../context/AuthProvider";
import { client } from "../services/client";
import { API_CONFIG } from "../data/settings";

// верхнее меню, как в ilida.ai.client: родительский пункт - выпадающая кнопка со страницами
const MENU = [
    { text: "Справочники", items: [{ text: "Полёты", path: "/flights" }, { text: "Модели", path: "/models" }] },
    { text: "Запуск", items: [{ text: "Сценарии", path: "/scenarios" }, { text: "История запусков", path: "/history" }] },
];

// шапка с меню и страница под ней
export default function Layout() {
    const { user, setAuth } = useAuthContext();
    const navigate = useNavigate();
    const { pathname } = useLocation();

    const logout = async () => {
        try {
            await client.post(API_CONFIG.apiData.endpoints.authLogout);
        }
        finally {
            setAuth(false, null);
            navigate("/login", { replace: true });
        }
    };

    return (
        <div className="radar-shell">
            <AppBar positionMode="sticky" themeColor="base">
                <AppBarSection>
                    <Button fillMode="flat" className="radar-shell__title" title="Новый запуск" onClick={() => navigate("/runs")}>
                        Прогноз положения БПЛА
                    </Button>
                </AppBarSection>

                <AppBarSection className="radar-shell__menu">
                    {MENU.map((group) => (
                        <DropDownButton key={group.text} text={group.text} fillMode="flat" items={group.items} textField="text"
                            className={group.items.some((i) => pathname.startsWith(i.path)) ? "radar-shell__menu--active" : undefined}
                            onItemClick={(e) => navigate((e.item as { path: string }).path)} />
                    ))}
                </AppBarSection>

                <AppBarSpacer />

                <AppBarSection>
                    <span className="radar-shell__user">{user?.displayName}</span>
                    <Button fillMode="flat" svgIcon={logoutIcon} title="Выход" onClick={logout} />
                </AppBarSection>
            </AppBar>

            <main className="radar-shell__page">
                <Outlet />
            </main>
        </div>
    );
}
