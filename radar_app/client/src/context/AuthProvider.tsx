import React, { createContext, useContext, useEffect, useState } from "react";

import { client } from "../services/client";
import { API_CONFIG } from "../data/settings";
import type { UserData } from "../data/dataModel";

interface AuthContextProps {
    isLoaded: boolean;
    isAuthenticated: boolean;
    user: UserData | null;
    setAuth: (auth: boolean, user: UserData | null) => void;
}

const AuthContext = createContext<AuthContextProps>({
    isLoaded: false,
    isAuthenticated: false,
    user: null,
    setAuth: () => { },
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [isLoaded, setIsLoaded] = useState<boolean>(false);
    const [isAuthenticated, setAuthState] = useState<boolean>(false);
    const [user, setUser] = useState<UserData | null>(null);

    const setAuth = React.useCallback((auth: boolean, value: UserData | null) => {
        setAuthState(auth);
        setUser(value);
    }, []);

    // сеанс по cookie: токен доступа жив - вход не нужен; истек (30 мин), но жив токен обновления - обновить без входа
    useEffect(() => {
        const controller = new AbortController();
        const { authGetUser, authRefresh } = API_CONFIG.apiData.endpoints;

        client.get<UserData>(authGetUser, { signal: controller.signal })
            .catch(() => client.post<UserData>(authRefresh, null, { signal: controller.signal }))
            .then((response) => setAuth(true, response.data))
            .catch(() => {
                if (!controller.signal.aborted) setAuth(false, null);
            })
            .finally(() => {
                if (!controller.signal.aborted) setIsLoaded(true);
            });

        return () => controller.abort();
    }, [setAuth]);

    return (
        <AuthContext.Provider value={{ isLoaded, isAuthenticated, user, setAuth }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuthContext = () => useContext(AuthContext);
