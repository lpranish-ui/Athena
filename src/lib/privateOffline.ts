import AsyncStorage from '@react-native-async-storage/async-storage';

import { createPrivateOfflineStorage } from './offlineStorage';

export const privateOffline = createPrivateOfflineStorage(AsyncStorage);
export const setOfflineAccount = (accountId: string | null) => privateOffline.setAccount(accountId);
export const clearPrivateOfflineData = () => privateOffline.clear();
