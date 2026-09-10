import {createContext, useContext} from 'react';
import {useMusic as useOriginalMusic} from '../../../../src/hooks/useMusic';

export const SoundContext = createContext('arrival.m4a');
export function useMusic(track: string | null, enabled: boolean) {
  const sound = useContext(SoundContext);
  useOriginalMusic(track ? track.replace('/audio/arrival.m4a', '/round-3/' + sound) : null, enabled);
}
