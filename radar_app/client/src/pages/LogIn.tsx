import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@progress/kendo-react-buttons';
import { Input } from '@progress/kendo-react-inputs';
import { Label } from '@progress/kendo-react-labels';
import { eyeIcon, eyeSlashIcon } from '@progress/kendo-svg-icons';

import { useAuthContext } from '../context/AuthProvider';
import { client } from '../services/client';
import { API_CONFIG } from '../data/settings';
import type { UserData } from '../data/dataModel';
import { getApiErrorMessage } from '../helpers/apiError';

export default function LogIn() {
    const { setAuth } = useAuthContext();
    const navigate = useNavigate();

    const [userName, setUserName] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [busy, setBusy] = useState(false);
    const [authError, setAuthError] = useState<string | null>(null);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setAuthError(null);
        setBusy(true);

        try {
            const response = await client.post<UserData>(API_CONFIG.apiData.endpoints.authLogin, { userName, password });
            setAuth(true, response.data);

            const from = sessionStorage.getItem('redirectAfterLogin') || '/';
            sessionStorage.removeItem('redirectAfterLogin');
            navigate(from, { replace: true });
        }
        catch (error) {
            setAuthError(getApiErrorMessage(error, 'Не удалось войти'));
        }
        finally {
            setBusy(false);
        }
    };

    return (
        <div className="radar-login">
            <form className="radar-login__card k-elevation-2" onSubmit={submit}>
                <h2 className="radar-login__title">Прогноз положения БПЛА</h2>
                <div className="radar-login__subtitle">Вход в систему</div>

                <Label editorId="userName">Имя пользователя</Label>
                <Input id="userName" value={userName} autoFocus autoComplete="username"
                    onChange={(e) => setUserName(String(e.value ?? ''))} />

                <Label editorId="password">Пароль</Label>
                <div className="radar-login__password">
                    <Input id="password" type={showPassword ? 'text' : 'password'} value={password} autoComplete="current-password"
                        onChange={(e) => setPassword(String(e.value ?? ''))} />
                    <Button type="button" fillMode="flat" svgIcon={showPassword ? eyeSlashIcon : eyeIcon}
                        title={showPassword ? 'Скрыть пароль' : 'Показать пароль'} onClick={() => setShowPassword(!showPassword)} />
                </div>

                {authError && <div className="radar-error">{authError}</div>}

                <Button themeColor="primary" type="submit" disabled={busy || !userName || !password}>Войти</Button>
            </form>
        </div>
    );
}
