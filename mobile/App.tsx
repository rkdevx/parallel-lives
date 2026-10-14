import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAudioPlayer } from 'expo-audio';
import * as AuthSession from 'expo-auth-session';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { WebView } from 'react-native-webview';

const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://10.0.2.2:8000').replace(/\/$/, '');
const TOKEN_KEY = 'parallel-lives-token';
const SPOTIFY_TOKEN_KEY = 'parallel-lives-spotify-session';
const SPOTIFY_CLIENT_ID = process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID || '';
const SPOTIFY_REDIRECT_SCHEME = 'parallel-lives-login';
const SPOTIFY_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};
const VIBE_OPTIONS = ['music', 'coffee', 'slow-life', 'food', 'books', 'walks', 'art', 'nature'];
const PLANT_STAGES = [
  { emoji: '🌰', title: 'A seed is waiting', detail: 'A shared answer will help it sprout.', size: 28 },
  { emoji: '🌱', title: 'A little sprout', detail: 'One shared day of answers.', size: 38 },
  { emoji: '🪴', title: 'Growing leaves', detail: 'Two shared days of answers.', size: 48 },
  { emoji: '🌷', title: 'First flower', detail: 'Three shared days of answers.', size: 58 },
];
const ROOM_SOUNDTRACKS = [
  { id: 'room-tone', title: 'Room tone', subtitle: 'Soft and unhurried', scene: '#eadfd1', source: require('./assets/soundscapes/room-tone.wav') },
  { id: 'rain-on-glass', title: 'Rain on glass', subtitle: 'A quiet rainy afternoon', scene: '#c8d5d7', source: require('./assets/soundscapes/rain-on-glass.wav') },
  { id: 'river-walk', title: 'River walk', subtitle: 'Water moving nearby', scene: '#c7e0d6', source: require('./assets/soundscapes/river-walk.wav') },
  { id: 'morning-birds', title: 'Morning birds', subtitle: 'A slow start to the day', scene: '#e1dfbd', source: require('./assets/soundscapes/morning-birds.wav') },
  { id: 'wind-in-leaves', title: 'Wind in leaves', subtitle: 'A little green and open air', scene: '#cedbb8', source: require('./assets/soundscapes/wind-in-leaves.wav') },
  { id: 'ocean-hush', title: 'Ocean hush', subtitle: 'Soft waves rolling in', scene: '#bfd8e2', source: require('./assets/soundscapes/ocean-hush.wav') },
  { id: 'night-crickets', title: 'Night crickets', subtitle: 'A calm evening outside', scene: '#d4cdbb', source: require('./assets/soundscapes/night-crickets.wav') },
  { id: 'cafe-window', title: 'Cafe window', subtitle: 'A warm hum in the background', scene: '#ddc8b2', source: require('./assets/soundscapes/cafe-window.wav') },
  { id: 'forest-dawn', title: 'Forest dawn', subtitle: 'Birdsong through the trees', scene: '#c8d9c1', source: require('./assets/soundscapes/forest-dawn.wav') },
  { id: 'soft-fireplace', title: 'Soft fireplace', subtitle: 'A little warmth indoors', scene: '#dfc4aa', source: require('./assets/soundscapes/soft-fireplace.wav') },
];

function getRoomSoundtrack(id: string | undefined) {
  return ROOM_SOUNDTRACKS.find((soundtrack) => soundtrack.id === id) || ROOM_SOUNDTRACKS[0];
}

WebBrowser.maybeCompleteAuthSession();

function spotifyTrackUrl(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^https?:\/\/open\.spotify\.com\/(track|album|playlist)\/([A-Za-z0-9]+)(?:[?#].*)?$/i);
  return match ? `https://open.spotify.com/${match[1]}/${match[2]}` : null;
}

function spotifyEmbedUrl(value: string | null): string | null {
  const trackUrl = spotifyTrackUrl(value);
  return trackUrl ? `${trackUrl.replace('open.spotify.com/', 'open.spotify.com/embed/')}?utm_source=generator&theme=0` : null;
}

type User = {
  id: string;
  phone_number: string;
  anonymous_handle: string;
  neighborhood_tag: string;
  latitude: number | null;
  longitude: number | null;
};

type Asset = {
  id: string;
  author_id: string;
  asset_type: string;
  content: string | null;
  media_url: string | null;
  created_at: string;
};

type Room = {
  room_id: string;
  room_level: number;
  day_streak: number;
  days_elapsed: number;
  daily_prompt: {
    day: number;
    question: string;
    my_answer: string | null;
    partner_answer: string | null;
    revealed: boolean;
  };
  share_more: {
    available: boolean;
    my_vote: number | null;
    mutual: boolean;
    partner_vibe_tags: string[];
  };
  plant_growth: { stage: number; completed_days: number };
  partner_inactive_hours: number | null;
  can_rematch: boolean;
  days_until_unmask: number;
  unmask_day_threshold: number;
  shared_state: { plant_health: number; active_track: string | null; theme: string; ambience_id?: string };
  assets: Asset[];
  partner: { anonymous_handle: string; neighborhood_tag: string; verification_tier: string } | null;
  demo_companion: boolean;
  is_unmasked: boolean;
  friendship_id: string | null;
  my_unmask_vote: number | null;
};

type GroupMember = { id: string; anonymous_handle: string; neighborhood_tag: string; verification_tier: string };
type GroupRoom = { group_id: string; created_at: string; members: GroupMember[]; member_count: number; you_id: string };
type MatchStatus =
  | { status: 'idle' }
  | { status: 'waiting'; queued_at: string }
  | { status: 'matched'; room: Room }
  | { status: 'group'; group: GroupRoom };
type MatchSearchResult = Room | { status: 'waiting'; queued_at: string } | { status: 'group'; group: GroupRoom };

type Message = { id: string; author_id: string; content: string; created_at: string };
type Friendship = { friendship_id: string; anonymous_handle: string; neighborhood_tag: string; verification_tier: string };
type SpotifyMetadata = { title: string; author_name: string };
type SpotifyTrack = {
  id: string;
  name: string;
  artists: { name: string }[];
  album: { images: { url: string }[] };
};
type SpotifySession = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  userId: string;
};

async function getDeviceCoordinates(): Promise<{ latitude: number; longitude: number }> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Location permission is required for Pune matching.');
  const provider = await Location.getProviderStatusAsync();
  if (!provider.locationServicesEnabled) {
    throw new Error('Turn on Android Location services, then try again. In BlueStacks also set a location from its side toolbar.');
  }
  if (Platform.OS === 'android') await Location.enableNetworkProviderAsync().catch(() => undefined);
  let position = await Location.getLastKnownPositionAsync({ maxAge: 120_000, requiredAccuracy: 5_000 });
  if (!position) {
    try {
      position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
        mayShowUserSettingsDialog: true,
      });
    } catch {
      throw new Error('BlueStacks did not return a location. Set it from the side toolbar, or use the development-only Pune test location.');
    }
  }
  return { latitude: position.coords.latitude, longitude: position.coords.longitude };
}

async function readSpotifySession(): Promise<SpotifySession | null> {
  const value = Platform.OS === 'web'
    ? await AsyncStorage.getItem(SPOTIFY_TOKEN_KEY)
    : await SecureStore.getItemAsync(SPOTIFY_TOKEN_KEY);
  return value ? JSON.parse(value) as SpotifySession : null;
}

async function writeSpotifySession(session: SpotifySession): Promise<void> {
  const value = JSON.stringify(session);
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(SPOTIFY_TOKEN_KEY, value);
  } else {
    await SecureStore.setItemAsync(SPOTIFY_TOKEN_KEY, value);
  }
}

async function deleteSpotifySession(): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(SPOTIFY_TOKEN_KEY);
  } else {
    await SecureStore.deleteItemAsync(SPOTIFY_TOKEN_KEY);
  }
}

async function request<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(result.detail)
      ? result.detail.map((item: { msg?: string }) => item.msg || 'Invalid input').join('. ')
      : result.detail;
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return result as T;
}

function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, styles[`button_${variant}`], disabled && styles.buttonDisabled]}
    >
      <Text style={[styles.buttonText, styles[`buttonText_${variant}`]]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Field(props: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      placeholderTextColor="#77839a"
      style={styles.input}
      {...props}
    />
  );
}

export default function App() {
  const spotifyRedirectUri = AuthSession.makeRedirectUri({
    scheme: SPOTIFY_REDIRECT_SCHEME,
    path: 'callback',
    native: `${SPOTIFY_REDIRECT_SCHEME}://callback`,
  });
  const [spotifyAuthRequest, spotifyAuthResponse, promptSpotifyAuth] = AuthSession.useAuthRequest({
    clientId: SPOTIFY_CLIENT_ID || 'spotify-client-id-not-configured',
    redirectUri: spotifyRedirectUri,
    responseType: AuthSession.ResponseType.Code,
    scopes: ['user-top-read'],
    usePKCE: true,
    codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
  }, SPOTIFY_DISCOVERY);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [phone, setPhone] = useState('+91');
  const [otp, setOtp] = useState('');
  const [otpRequested, setOtpRequested] = useState(false);
  const [handle, setHandle] = useState('');
  const [neighborhood, setNeighborhood] = useState('Baner');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
    const [usingTestLocation, setUsingTestLocation] = useState(false);
  const [vibes, setVibes] = useState(['music', 'coffee', 'slow-life']);
  const [room, setRoom] = useState<Room | null>(null);
  const [groupRoom, setGroupRoom] = useState<GroupRoom | null>(null);
  const [groupMessages, setGroupMessages] = useState<Message[]>([]);
  const [groupMessageText, setGroupMessageText] = useState('');
  const [matching, setMatching] = useState(false);
  const [queuedAt, setQueuedAt] = useState<string | null>(null);
  const [tab, setTab] = useState<'room' | 'circle' | 'profile'>('room');
  const [note, setNote] = useState('');
  const [promptAnswer, setPromptAnswer] = useState('');
  const [photoUri, setPhotoUri] = useState('');
  const [photoBase64, setPhotoBase64] = useState('');
  const [photoType, setPhotoType] = useState('image/jpeg');
  const [spotifyLink, setSpotifyLink] = useState('');
  const [ambientEnabled, setAmbientEnabled] = useState(true);
  const [spotifyMetadata, setSpotifyMetadata] = useState<SpotifyMetadata | null>(null);
  const [spotifySession, setSpotifySession] = useState<SpotifySession | null>(null);
  const [spotifyTracks, setSpotifyTracks] = useState<SpotifyTrack[]>([]);
  const [spotifyLoading, setSpotifyLoading] = useState(false);
  const [spotifyStatus, setSpotifyStatus] = useState('');
  const [spotifyReloadKey, setSpotifyReloadKey] = useState(0);
  const [roomMessages, setRoomMessages] = useState<Message[]>([]);
  const [roomMessageText, setRoomMessageText] = useState('');
  const [roomChatOpen, setRoomChatOpen] = useState(false);
  const [partnerOnline, setPartnerOnline] = useState(false);
  const [friendships, setFriendships] = useState<Friendship[]>([]);
  const [selectedFriendship, setSelectedFriendship] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageText, setMessageText] = useState('');
  const socket = useRef<WebSocket | null>(null);
  const roomChatScrollRef = useRef<ScrollView | null>(null);
  const groupChatScrollRef = useRef<ScrollView | null>(null);
  const circleChatScrollRef = useRef<ScrollView | null>(null);
  const exchangedSpotifyCode = useRef<string | null>(null);
  const ambientPlayer = useAudioPlayer(ROOM_SOUNDTRACKS[0].source);
  const selectedSpotifyUrl = spotifyTrackUrl(room?.shared_state.active_track ?? null);
  const roomSoundtrack = getRoomSoundtrack(room?.shared_state.ambience_id);
  const ambiencePlaying = Boolean(room && tab === 'room' && ambientEnabled && !selectedSpotifyUrl);

  useEffect(() => {
    let active = true;
    if (!user?.id) return undefined;
    readSpotifySession().then(async (savedSession) => {
      if (!active) return;
      if (savedSession?.userId === user.id) {
        setSpotifySession(savedSession);
      } else {
        await deleteSpotifySession();
        setSpotifySession(null);
      }
    }).catch(() => {
      if (active) setSpotifyStatus('Could not read the saved Spotify connection.');
    });
    return () => {
      active = false;
    };
  }, [user?.id]);

  useEffect(() => {
    const authorizationCode = spotifyAuthResponse?.type === 'success'
      ? spotifyAuthResponse.params.code
      : undefined;
    if (!authorizationCode || !spotifyAuthRequest?.codeVerifier || !user?.id) return undefined;
    if (exchangedSpotifyCode.current === authorizationCode) return undefined;
    exchangedSpotifyCode.current = authorizationCode;
    let active = true;
    setSpotifyLoading(true);
    setSpotifyStatus('Connecting to Spotify…');
    AuthSession.exchangeCodeAsync({
      clientId: SPOTIFY_CLIENT_ID,
      code: authorizationCode,
      redirectUri: spotifyRedirectUri,
      extraParams: { code_verifier: spotifyAuthRequest.codeVerifier },
    }, SPOTIFY_DISCOVERY).then(async (response) => {
      const session: SpotifySession = {
        accessToken: response.accessToken,
        refreshToken: response.refreshToken ?? null,
        expiresAt: Date.now() + (response.expiresIn ?? 3600) * 1000,
        userId: user.id,
      };
      await writeSpotifySession(session);
      if (active) {
        setSpotifySession(session);
        setSpotifyStatus('Connected. Loading your top tracks…');
      }
    }).catch((reason: unknown) => {
      if (active) setSpotifyStatus(reason instanceof Error ? reason.message : 'Spotify connection failed.');
    }).finally(() => {
      if (active) setSpotifyLoading(false);
    });
    return () => {
      active = false;
    };
  }, [spotifyAuthRequest?.codeVerifier, spotifyAuthResponse, spotifyRedirectUri, user?.id]);

  useEffect(() => {
    if (!spotifySession || !user?.id || !SPOTIFY_CLIENT_ID) {
      setSpotifyTracks([]);
      return undefined;
    }
    let active = true;
    setSpotifyLoading(true);
    const loadTopTracks = async () => {
      let session = spotifySession;
      if (session.expiresAt <= Date.now() + 60_000) {
        if (!session.refreshToken) throw new Error('Spotify session expired. Connect Spotify again.');
        const refreshed = await fetch(SPOTIFY_DISCOVERY.tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
            client_id: SPOTIFY_CLIENT_ID,
          }),
        });
        const refreshedBody = await refreshed.json();
        if (!refreshed.ok) throw new Error(refreshedBody.error_description || 'Spotify session expired. Connect again.');
        session = {
          ...session,
          accessToken: refreshedBody.access_token,
          refreshToken: refreshedBody.refresh_token || session.refreshToken,
          expiresAt: Date.now() + (refreshedBody.expires_in || 3600) * 1000,
        };
      }
      const response = await fetch('https://api.spotify.com/v1/me/top/tracks?limit=3&time_range=medium_term', {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || 'Could not load your Spotify top tracks.');
      if (active) {
        if (session !== spotifySession) {
          await writeSpotifySession(session);
          setSpotifySession(session);
        }
        setSpotifyTracks(body.items ?? []);
        setSpotifyStatus((body.items ?? []).length ? 'Your top 3 tracks · last 6 months' : 'Spotify has no top tracks for this period yet.');
      }
    };
    loadTopTracks().catch((reason: unknown) => {
      if (active) {
        setSpotifyTracks([]);
        setSpotifyStatus(reason instanceof Error ? reason.message : 'Could not load your Spotify top tracks.');
      }
    }).finally(() => {
      if (active) setSpotifyLoading(false);
    });
    return () => {
      active = false;
    };
  }, [spotifyReloadKey, spotifySession, user?.id]);

  useEffect(() => {
    ambientPlayer.replace(roomSoundtrack.source);
    ambientPlayer.loop = true;
    ambientPlayer.volume = 0.22;
    if (ambiencePlaying) {
      ambientPlayer.play();
    } else {
      ambientPlayer.pause();
    }
  }, [ambientPlayer, ambiencePlaying, roomSoundtrack.id, roomSoundtrack.source]);

  useEffect(() => {
    if (roomChatOpen) roomChatScrollRef.current?.scrollToEnd({ animated: true });
  }, [roomChatOpen, roomMessages.length]);

  useEffect(() => {
    if (groupRoom) groupChatScrollRef.current?.scrollToEnd({ animated: true });
  }, [groupMessages.length, groupRoom]);

  useEffect(() => {
    if (selectedFriendship) circleChatScrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length, selectedFriendship]);

  useEffect(() => {
    if (!selectedSpotifyUrl) {
      setSpotifyMetadata(null);
      return undefined;
    }
    let active = true;
    fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(selectedSpotifyUrl)}`)
      .then((response) => {
        if (!response.ok) throw new Error('Spotify track details are unavailable.');
        return response.json();
      })
      .then((metadata: SpotifyMetadata) => {
        if (active) setSpotifyMetadata(metadata);
      })
      .catch(() => {
        if (active) setSpotifyMetadata(null);
      });
    return () => {
      active = false;
    };
  }, [selectedSpotifyUrl]);

  const reportError = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : 'Something went wrong. Please try again.');
  }, []);

  const applyMatchStatus = useCallback((status: MatchStatus) => {
    if (status.status === 'matched') {
      setRoom(status.room);
      setGroupRoom(null);
      setMatching(false);
      setQueuedAt(null);
    } else if (status.status === 'group') {
      setRoom(null);
      setGroupRoom(status.group);
      setMatching(false);
      setQueuedAt(null);
    } else if (status.status === 'waiting') {
      setRoom(null);
      setGroupRoom(null);
      setMatching(true);
      setQueuedAt(status.queued_at);
    } else {
      setMatching(false);
      setQueuedAt(null);
    }
  }, []);

  const loadRoom = useCallback(async (accessToken: string) => {
    try {
      const data = await request<Room>('/api/v1/room/active', accessToken);
      setRoom(data);
      setError('');
    } catch (reason) {
      if (reason instanceof Error && reason.message.includes('active room')) {
        setRoom(null);
        return;
      }
      throw reason;
    }
  }, []);

  const loadCircle = useCallback(async (accessToken: string) => {
    const result = await request<{ friendships: Friendship[] }>('/api/v1/circles', accessToken);
    setFriendships(result.friendships);
  }, []);

  const refreshSession = useCallback(async (accessToken: string) => {
    const result = await request<{ user: User; profile_complete: boolean }>('/api/v1/me', accessToken);
    setUser(result.user);
    if (result.profile_complete) {
      await loadRoom(accessToken);
      await loadCircle(accessToken);
      const matchStatus = await request<MatchStatus>('/api/v1/match/status', accessToken);
      applyMatchStatus(matchStatus);
    }
  }, [applyMatchStatus, loadCircle, loadRoom]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const savedToken = await AsyncStorage.getItem(TOKEN_KEY);
        if (savedToken) {
          await refreshSession(savedToken);
          if (mounted) setToken(savedToken);
        }
      } catch (reason) {
        await AsyncStorage.removeItem(TOKEN_KEY);
        if (mounted) reportError(reason);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
      socket.current?.close();
    };
  }, [refreshSession, reportError]);

  useEffect(() => {
    if (!token || !room?.room_id) return undefined;
    const wsUrl = `${API_URL.replace(/^http/, 'ws')}/ws/room/${room.room_id}?token=${encodeURIComponent(token)}`;
    const connection = new WebSocket(wsUrl);
    socket.current = connection;
    const presencePulse = setInterval(() => {
      if (connection.readyState === WebSocket.OPEN) {
        connection.send(JSON.stringify({ event: 'presence', online: true }));
      }
    }, 60_000);
    connection.onopen = () => connection.send(JSON.stringify({ event: 'presence', online: true }));
    connection.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.event === 'state_sync') {
          setRoom((current) => current ? {
            ...current,
            shared_state: { ...current.shared_state, ...data.payload },
            assets: data.payload.asset
              ? current.assets.some((asset) => asset.id === data.payload.asset.id)
                ? current.assets
                : [...current.assets, data.payload.asset]
              : current.assets,
          } : current);
        } else if (data.event === 'room_dissolved') {
          setRoom(null);
          setRoomMessages([]);
        } else if (data.event === 'room_message') {
          setRoomMessages((current) => current.some((message) => message.id === data.payload.id)
            ? current
            : [...current, data.payload]);
        } else if (data.event === 'daily_prompt_updated') {
          loadRoom(token).catch(reportError);
        } else if (data.event === 'share_more_updated') {
          loadRoom(token).catch(reportError);
        } else if (data.event === 'room_message') {
          setRoomMessages((current) => current.some((message) => message.id === data.payload.id)
            ? current
            : [...current, data.payload]);
        } else if (data.event === 'presence_glow') {
          if (data.payload?.from && data.payload.from !== user?.id) setPartnerOnline(Boolean(data.payload.online));
        } else if (data.event === 'haptic_nudge') {
          if (data.payload?.from !== user?.id) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Alert.alert('Coffee bump', 'Your companion sent a little hello.');
          }
        } else if (data.event === 'unmask_updated') {
          if (data.payload?.status === 'graduated') {
            setRoom(null);
            setRoomChatOpen(false);
            setTab('circle');
            loadCircle(token).catch(reportError);
          } else {
            loadRoom(token).catch(reportError);
          }
        }
      } catch {
        reportError(new Error('Received an invalid live room update.'));
      }
    };
    connection.onerror = () => setError('Live sync is disconnected. Check that the API server is running.');
    return () => {
      clearInterval(presencePulse);
      connection.close();
      if (socket.current === connection) socket.current = null;
    };
  }, [loadCircle, loadRoom, reportError, room?.room_id, token, user?.id]);

  useEffect(() => {
    if (!token || !room?.room_id) return undefined;
    let active = true;
    const refreshRoomContent = async () => {
      try {
        const [roomData, messageData] = await Promise.all([
          request<Room>('/api/v1/room/active', token),
          request<{ messages: Message[] }>('/api/v1/room/messages', token),
        ]);
        if (active) {
          setRoom(roomData);
          setRoomMessages(messageData.messages);
        }
      } catch (reason) {
        if (active) reportError(reason);
      }
    };
    const timer = setInterval(refreshRoomContent, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [reportError, room?.room_id, token]);

  useEffect(() => {
    if (!token || !matching) return undefined;
    let active = true;
    const checkMatch = async () => {
      try {
        const status = await request<MatchStatus>('/api/v1/match/status', token);
        if (!active) return;
        if (status.status === 'idle') {
          setMatching(false);
          setQueuedAt(null);
          setError('The search expired before anyone nearby joined. You can start a new search anytime.');
        } else {
          applyMatchStatus(status);
        }
      } catch (reason) {
        if (active) reportError(reason);
      }
    };
    checkMatch();
    const timer = setInterval(checkMatch, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [applyMatchStatus, matching, reportError, token]);

  useEffect(() => {
    if (!token || !groupRoom) {
      setGroupMessages([]);
      return undefined;
    }
    let active = true;
    const refreshGroup = async () => {
      try {
        const result = await request<{ messages: Message[] }>('/api/v1/group/messages', token);
        if (active) setGroupMessages(result.messages);
      } catch (reason) {
        if (active) reportError(reason);
      }
    };
    refreshGroup();
    const timer = setInterval(refreshGroup, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [groupRoom?.group_id, reportError, token]);

  useEffect(() => {
    if (!token || !room?.room_id) {
      setRoomMessages([]);
      return undefined;
    }
    let active = true;
    request<{ messages: Message[] }>('/api/v1/room/messages', token)
      .then((result) => {
        if (active) setRoomMessages(result.messages);
      })
      .catch((reason) => {
        if (active) reportError(reason);
      });
    return () => {
      active = false;
    };
  }, [reportError, room?.room_id, token]);

  useEffect(() => {
    if (!token || !selectedFriendship) return undefined;
    let active = true;
    const refreshMessages = async () => {
      try {
        const result = await request<{ messages: Message[] }>(`/api/v1/circles/${selectedFriendship}/messages`, token);
        if (active) setMessages(result.messages);
      } catch (reason) {
        if (active) reportError(reason);
      }
    };
    refreshMessages();
    const timer = setInterval(refreshMessages, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [reportError, selectedFriendship, token]);

  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(false);
    }
  };

  const requestOtp = () => perform(async () => {
    const result = await request<{ demo_code?: string }>('/api/v1/auth/request-otp', undefined, {
      method: 'POST',
      body: JSON.stringify({ phone }),
    });
    setOtpRequested(true);
    if (result.demo_code) setOtp(result.demo_code);
  });

  const verifyOtp = () => perform(async () => {
    const result = await request<{ token: string; user: User }>('/api/v1/auth/verify-otp', undefined, {
      method: 'POST',
      body: JSON.stringify({ phone, code: otp }),
    });
    await AsyncStorage.setItem(TOKEN_KEY, result.token);
    setToken(result.token);
    setUser(result.user);
  });

  const locateMe = () => perform(async () => {
    const coordinates = await getDeviceCoordinates();
    setLatitude(coordinates.latitude.toFixed(6));
    setLongitude(coordinates.longitude.toFixed(6));
    setUsingTestLocation(false);
  });

  const usePuneTestLocation = () => {
    setLatitude('18.520400');
    setLongitude('73.856700');
    setUsingTestLocation(true);
    setError('');
  };

  const toggleVibe = (vibe: string) => {
    setVibes((current) => current.includes(vibe)
      ? current.filter((selected) => selected !== vibe)
      : [...current, vibe]);
  };

  const saveProfile = () => perform(async () => {
    if (!token) return;
    const result = await request<{ user: User }>('/api/v1/profile', token, {
      method: 'POST',
      body: JSON.stringify({
        handle,
        neighborhood,
        latitude: Number(latitude),
        longitude: Number(longitude),
        vibes,
      }),
    });
    setUser({ ...user!, ...result.user });
    setError('');
  });

  const findCompanion = () => perform(async () => {
    if (!token) return;
    setError('');
    setRoom(null);
    setGroupRoom(null);
    setMatching(true);
    try {
      const coordinates = usingTestLocation && latitude && longitude
        ? { latitude: Number(latitude), longitude: Number(longitude) }
        : await getDeviceCoordinates();
      setLatitude(coordinates.latitude.toFixed(6));
      setLongitude(coordinates.longitude.toFixed(6));
      const result = await request<MatchSearchResult>('/api/v1/match/find-companion', token, {
        method: 'POST',
        body: JSON.stringify({
          latitude: coordinates.latitude,
          longitude: coordinates.longitude,
          vibe_filters: vibes,
        }),
      });
      if ('room_id' in result) {
        setRoom(result);
        setMatching(false);
        setQueuedAt(null);
      } else if (result.status === 'group') {
        setRoom(null);
        setGroupRoom(result.group);
        setMatching(false);
        setQueuedAt(null);
      } else {
        setQueuedAt(result.queued_at);
      }
      setTab('room');
      if (!('status' in result) || result.status !== 'waiting') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (reason) {
      setMatching(false);
      setQueuedAt(null);
      throw reason;
    }
  });

  const cancelMatchSearch = () => perform(async () => {
    if (!token) return;
    const result = await request<{ status: string }>('/api/v1/match/queue', token, { method: 'DELETE' });
    if (result.status === 'cancelled') {
      setMatching(false);
      setQueuedAt(null);
    } else {
      applyMatchStatus(await request<MatchStatus>('/api/v1/match/status', token));
    }
  });

  const sendGroupMessage = () => perform(async () => {
    if (!token || !groupMessageText.trim()) return;
    await request('/api/v1/group/messages', token, {
      method: 'POST',
      body: JSON.stringify({ content: groupMessageText.trim() }),
    });
    setGroupMessageText('');
    const result = await request<{ messages: Message[] }>('/api/v1/group/messages', token);
    setGroupMessages(result.messages);
  });

  const leaveGroup = () => perform(async () => {
    if (!token) return;
    await request('/api/v1/group/leave', token, { method: 'POST' });
    setGroupRoom(null);
    setGroupMessages([]);
  });

  const groupMemberOptions = (member: GroupMember) => Alert.alert(
    `@${member.anonymous_handle}`,
    'Choose a safety action.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Report member', onPress: () => perform(async () => {
        if (!token) return;
        await request('/api/v1/group/report', token, {
          method: 'POST',
          body: JSON.stringify({ reported_user_id: member.id, reason: 'Reported from the group safety menu.' }),
        });
        Alert.alert('Report received', 'Our safety team will review it.');
      }) },
      { text: 'Block and leave group', style: 'destructive', onPress: () => perform(async () => {
        if (!token) return;
        await request('/api/v1/group/block', token, {
          method: 'POST',
          body: JSON.stringify({ blocked_user_id: member.id }),
        });
        setGroupRoom(null);
        setGroupMessages([]);
      }) },
    ],
  );

  const postAsset = () => perform(async () => {
    if (!token) return;
    const result = await request<{ asset: Asset }>('/api/v1/room/asset', token, {
      method: 'POST',
      body: JSON.stringify({
        asset_type: 'sticky_note',
        content: note.trim(),
      }),
    });
    setRoom((current) => current ? {
      ...current,
      assets: current.assets.some((asset) => asset.id === result.asset.id)
        ? current.assets
        : [...current.assets, result.asset],
    } : current);
    setNote('');
  });

  const answerDailyPrompt = () => perform(async () => {
    if (!token || !room || !promptAnswer.trim()) return;
    const result = await request<{ daily_prompt: Room['daily_prompt'] }>('/api/v1/room/daily-prompt', token, {
      method: 'POST',
      body: JSON.stringify({ day: room.daily_prompt.day, answer: promptAnswer.trim() }),
    });
    await loadRoom(token);
    setPromptAnswer('');
  });

  const sendRoomMessage = () => perform(async () => {
    if (!token || !roomMessageText.trim()) return;
    const result = await request<{ message: Message }>('/api/v1/room/messages', token, {
      method: 'POST',
      body: JSON.stringify({ content: roomMessageText.trim() }),
    });
    setRoomMessages((current) => current.some((message) => message.id === result.message.id)
      ? current
      : [...current, result.message]);
    setRoomMessageText('');
  });

  const shareMore = (accept: boolean) => perform(async () => {
    if (!token) return;
    const result = await request<{ status: string }>('/api/v1/room/share-more', token, {
      method: 'POST',
      body: JSON.stringify({ accept }),
    });
    if (result.status === 'graduated') {
      setRoom(null);
      setRoomChatOpen(false);
      await loadCircle(token);
      setTab('circle');
    } else {
      await loadRoom(token);
    }
  });

  const choosePhoto = () => perform(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new Error('Photo library permission is required to choose a polaroid.');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
    });
    if (result.canceled) return;
    const selected = result.assets[0];
    const prepared = await ImageManipulator.manipulateAsync(
      selected.uri,
      [{ resize: { width: Math.min(1600, selected.width) } }],
      { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    if (!prepared.base64) throw new Error('Could not prepare the selected image. Please choose another photo.');
    setPhotoUri(prepared.uri);
    setPhotoBase64(prepared.base64);
    setPhotoType('image/jpeg');
  });

  const uploadPolaroid = () => perform(async () => {
    if (!token || !photoBase64) return;
    const result = await request<{ asset: Asset }>('/api/v1/room/polaroid', token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: photoBase64, content_type: photoType }),
    });
    setRoom((current) => current ? {
      ...current,
      assets: current.assets.some((asset) => asset.id === result.asset.id)
        ? current.assets
        : [...current.assets, result.asset],
    } : current);
    setPhotoUri('');
    setPhotoBase64('');
  });

  const sendNudge = async () => {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) {
      setError('Live sync is not connected yet. Try again in a moment.');
      return;
    }
    socket.current.send(JSON.stringify({ event: 'haptic_nudge' }));
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const changeTrack = () => perform(async () => {
    const nextTrack = spotifyTrackUrl(spotifyLink.trim());
    if (!nextTrack) throw new Error('Paste a Spotify track, album, or playlist link.');
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) throw new Error('Live sync is not connected yet.');
    socket.current.send(JSON.stringify({ event: 'update_jukebox', track_id: nextTrack }));
    setSpotifyLink('');
  });

  const clearSpotifyTrack = () => perform(async () => {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) throw new Error('Live sync is not connected yet.');
    socket.current.send(JSON.stringify({ event: 'update_jukebox', track_id: '' }));
  });

  const cycleRoomSoundtrack = () => {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) {
      setError('Live sync is not connected yet. Try again in a moment.');
      return;
    }
    const currentIndex = ROOM_SOUNDTRACKS.findIndex((soundtrack) => soundtrack.id === room?.shared_state.ambience_id);
    const nextSoundtrack = ROOM_SOUNDTRACKS[(currentIndex + 1) % ROOM_SOUNDTRACKS.length];
    socket.current.send(JSON.stringify({ event: 'update_room_ambience', ambience_id: nextSoundtrack.id }));
  };

  const connectSpotify = () => {
    if (!SPOTIFY_CLIENT_ID) {
      setSpotifyStatus('Set EXPO_PUBLIC_SPOTIFY_CLIENT_ID and rebuild the mobile app to connect.');
      return;
    }
    if (!spotifyAuthRequest) {
      setSpotifyStatus('Spotify sign-in is still loading. Try again in a moment.');
      return;
    }
    setSpotifyStatus('Opening Spotify sign-in…');
    promptSpotifyAuth().catch((reason: unknown) => {
      setSpotifyStatus(reason instanceof Error ? reason.message : 'Spotify sign-in could not be opened.');
    });
  };

  const selectSpotifyTrack = (selectedTrack: SpotifyTrack) => perform(async () => {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) throw new Error('Live sync is not connected yet.');
    socket.current.send(JSON.stringify({
      event: 'update_jukebox',
      track_id: `https://open.spotify.com/track/${selectedTrack.id}`,
    }));
  });

  const removeSpotifyConnection = () => perform(async () => {
    await deleteSpotifySession();
    setSpotifySession(null);
    setSpotifyTracks([]);
    setSpotifyStatus('Spotify connection removed from this device.');
  });

  const voteToUnmask = (accept: boolean) => perform(async () => {
    if (!token) return;
    const result = await request<{ status: string }>('/api/v1/room/unmask-opt-in', token, {
      method: 'POST',
      body: JSON.stringify({ accept }),
    });
    if (result.status === 'graduated') {
      setRoom(null);
      await loadCircle(token);
      setTab('circle');
    } else if (accept) {
      await loadRoom(token);
    } else {
      setRoom(null);
    }
  });

  const dissolveRoom = () => perform(async () => {
    if (!token) return;
    await request('/api/v1/room/dissolve', token, { method: 'POST' });
    setRoom(null);
  });

  const blockPartner = () => Alert.alert(
    'Block and leave this room?',
    'You will leave the room and this account will not be matched with you again.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block and leave', style: 'destructive', onPress: () => perform(async () => {
        if (!token) return;
        await request('/api/v1/room/block', token, { method: 'POST' });
        setRoom(null);
        setRoomMessages([]);
      }) },
    ],
  );

  const leaveAndRematch = () => Alert.alert(
    'Find another connection?',
    'This room has been quiet for a day. You can leave it and try another room.',
    [
      { text: 'Stay here', style: 'cancel' },
      { text: 'Leave and rematch', onPress: () => perform(async () => {
        if (!token) return;
        await request('/api/v1/room/dissolve', token, { method: 'POST' });
        setRoom(null);
        setRoomMessages([]);
        const nextMatch = await request<MatchSearchResult>('/api/v1/match/find-companion', token, {
          method: 'POST',
          body: JSON.stringify({
            latitude: Number(latitude || user?.latitude),
            longitude: Number(longitude || user?.longitude),
            vibe_filters: vibes,
          }),
        });
        if ('room_id' in nextMatch) {
          setRoom(nextMatch);
          setMatching(false);
        } else if (nextMatch.status === 'group') {
          setGroupRoom(nextMatch.group);
          setMatching(false);
        } else {
          setMatching(true);
          setQueuedAt(nextMatch.queued_at);
        }
      }) },
    ],
  );

  const sendReport = (reason: string) => perform(async () => {
    if (!token) return;
    await request('/api/v1/room/report', token, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    Alert.alert('Report received', 'Our safety team will review it.');
  });

  const reportSafetyConcern = () => Alert.alert('Report a safety concern', 'Choose the closest reason.', [
    { text: 'Harassment or hateful behavior', onPress: () => sendReport('Harassment or hateful behavior') },
    { text: 'Privacy or unwanted pressure', onPress: () => sendReport('Privacy or unwanted pressure') },
    { text: 'Cancel', style: 'cancel' },
  ]);

  const sendMessage = () => perform(async () => {
    if (!token || !selectedFriendship || !messageText.trim()) return;
    await request(`/api/v1/circles/${selectedFriendship}/messages`, token, {
      method: 'POST',
      body: JSON.stringify({ content: messageText.trim() }),
    });
    setMessageText('');
    const result = await request<{ messages: Message[] }>(`/api/v1/circles/${selectedFriendship}/messages`, token);
    setMessages(result.messages);
  });

  const signOut = () => perform(async () => {
    if (token && matching) await request('/api/v1/match/queue', token, { method: 'DELETE' });
    if (token && groupRoom) await request('/api/v1/group/leave', token, { method: 'POST' });
    if (token) await request('/api/v1/auth/logout', token, { method: 'POST' });
    await AsyncStorage.removeItem(TOKEN_KEY);
    await deleteSpotifySession();
    socket.current?.close();
    setToken(null);
    setUser(null);
    setRoom(null);
    setGroupRoom(null);
    setGroupMessages([]);
    setMatching(false);
    setFriendships([]);
    setRoomMessages([]);
    setSpotifySession(null);
    setSpotifyTracks([]);
  });

  if (loading) {
    return <SafeAreaView style={styles.center}><ActivityIndicator size="large" color="#76e1bd" /></SafeAreaView>;
  }

  if (!token) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.authPage} keyboardShouldPersistTaps="handled">
            <Text style={styles.eyebrow}>PUNE • PCMC</Text>
            <Text style={styles.hero}>Make room{'\n'}for a new kind{'\n'}of connection.</Text>
            <Text style={styles.body}>No swiping. Just two anonymous people, one shared space, and ten unhurried days.</Text>
            <Text style={styles.label}>PHONE NUMBER</Text>
            <Field value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+91 98765 43210" />
            {otpRequested && <>
              <Text style={styles.label}>DEMO VERIFICATION CODE</Text>
              <Field value={otp} onChangeText={setOtp} keyboardType="number-pad" placeholder="6-digit code" />
              <Text style={styles.muted}>Local prototype only — the demo code is prefilled. No SMS is sent.</Text>
            </>}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Button label={busy ? 'Please wait…' : otpRequested ? 'Verify & enter' : 'Continue with phone'} onPress={otpRequested ? verifyOtp : requestOtp} disabled={busy} />
            <Text style={styles.disclaimer}>By continuing, you agree to keep this space kind and respectful.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (!user?.anonymous_handle) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <Text style={styles.eyebrow}>FIRST, A LITTLE ABOUT YOU</Text>
          <Text style={styles.heading}>Your anonymous self</Text>
          <Text style={styles.body}>Choose a handle and confirm you are in Pune. Your precise location is used for matching, not shown to your companion.</Text>
          <Text style={styles.label}>ANONYMOUS HANDLE</Text>
          <Field value={handle} onChangeText={setHandle} autoCapitalize="none" placeholder="e.g. softorbit" maxLength={30} />
          <Text style={styles.label}>NEIGHBORHOOD</Text>
          <Field value={neighborhood} onChangeText={setNeighborhood} placeholder="Baner, Pune" />
          <View style={styles.locationBlock}>
            <Text style={styles.label}>PRIVATE LOCATION</Text>
            <Text style={styles.body}>{latitude && longitude ? 'Location confirmed for Pune matching.' : 'Confirm you are in Pune to find a nearby companion.'}</Text>
            <Text style={styles.muted}>Your precise coordinates stay private and are only used to check eligibility and matching distance.</Text>
            <Button
              label={latitude && longitude ? 'Update my location' : 'Use my current location'}
              onPress={locateMe}
              variant="secondary"
              disabled={busy}
            />
            {__DEV__ && Platform.OS === 'android' ? (
              <Button label="Use Pune test location · development only" onPress={usePuneTestLocation} variant="quiet" disabled={busy} />
            ) : null}
          </View>
          <Text style={styles.label}>PICK A FEW VIBES</Text>
          <View style={styles.vibeList}>
            {VIBE_OPTIONS.map((vibe) => {
              const selected = vibes.includes(vibe);
              return (
                <TouchableOpacity
                  key={vibe}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => toggleVibe(vibe)}
                  style={[styles.vibeChip, selected && styles.vibeChipSelected]}
                >
                  <Text style={[styles.vibeText, selected && styles.vibeTextSelected]}>{vibe}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button label={busy ? 'Saving…' : 'Save my profile'} onPress={saveProfile} disabled={busy || !latitude || !longitude || vibes.length === 0} />
          <Button label="Sign out" onPress={signOut} variant="quiet" disabled={busy} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>PARALLEL LIVES</Text>
          <Text style={styles.headerTitle}>{tab === 'room' ? groupRoom ? 'A small circle' : 'Your little world' : tab === 'circle' ? 'Your circle' : 'Your profile'}</Text>
        </View>
        <Text style={styles.handle}>@{user.anonymous_handle}</Text>
      </View>
      {!!error && <TouchableOpacity onPress={() => setError('')}><Text style={styles.errorBanner}>{error}  ×</Text></TouchableOpacity>}
      {tab === 'room' && room && roomChatOpen ? (
        <KeyboardAvoidingView style={styles.chatScreen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.chatTopBar}>
            <TouchableOpacity accessibilityRole="button" onPress={() => setRoomChatOpen(false)} style={styles.chatBackButton}>
              <Text style={styles.spotifyLink}>‹ ROOM</Text>
            </TouchableOpacity>
            <View style={styles.flex}>
              <Text style={styles.friendName}>@{room.partner?.anonymous_handle || 'your companion'}</Text>
              <Text style={styles.muted}>{partnerOnline ? 'Here now' : 'Anonymous · messages stay here'}</Text>
            </View>
            <TouchableOpacity accessibilityRole="button" onPress={reportSafetyConcern}>
              <Text style={styles.spotifyLink}>•••</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            ref={roomChatScrollRef}
            style={styles.chatHistory}
            contentContainerStyle={styles.chatHistoryContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.chatDayNotice}>DAY {room.day_streak} · YOUR CHAT IS PRIVATE</Text>
            {roomMessages.length ? roomMessages.map((message) => (
              <View key={message.id} style={[styles.whatsappBubble, message.author_id === user.id ? styles.whatsappBubbleMine : styles.whatsappBubbleTheirs]}>
                {message.author_id !== user.id ? <Text style={styles.roomMessageAuthor}>@{room.partner?.anonymous_handle || 'COMPANION'}</Text> : null}
                <Text style={styles.roomMessageContent}>{message.content}</Text>
                <Text style={styles.chatTimestamp}>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
              </View>
            )) : (
              <View style={styles.chatEmptyHint}>
                <Text style={styles.body}>A first hello doesn’t need to be clever.</Text>
                <Text style={styles.muted}>Try asking how their day is going.</Text>
              </View>
            )}
          </ScrollView>
          <View style={styles.chatComposer}>
            <Field
              value={roomMessageText}
              onChangeText={setRoomMessageText}
              placeholder="Message"
              maxLength={1000}
              multiline
              returnKeyType="send"
              style={styles.chatInput}
              onSubmitEditing={sendRoomMessage}
            />
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Send message"
              disabled={busy || !roomMessageText.trim()}
              onPress={sendRoomMessage}
              style={[styles.chatSendButton, (busy || !roomMessageText.trim()) && styles.buttonDisabled]}
            >
              <Text style={styles.chatSendText}>↑</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      ) : null}
      {tab === 'room' && !roomChatOpen && (
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          {groupRoom ? (
            <View style={styles.groupExperience}>
              <View style={styles.groupIntro}>
                <Text style={styles.eyebrow}>NEARBY, TOGETHER</Text>
                <Text style={styles.heading}>{groupRoom.member_count} people, one open room.</Text>
                <Text style={styles.body}>A small circle formed because a one-to-one match wasn’t available. Say hello, or leave whenever you like.</Text>
              </View>
              <View style={styles.groupMembers}>
                <Text style={styles.panelTitle}>In this circle</Text>
                {groupRoom.members.map((member) => (
                  <View key={member.id} style={styles.groupMemberRow}>
                    <View style={styles.flex}>
                      <Text style={styles.friendName}>@{member.anonymous_handle}{member.id === groupRoom.you_id ? ' · YOU' : ''}</Text>
                      <Text style={styles.muted}>{member.neighborhood_tag} · {member.verification_tier}</Text>
                    </View>
                    {member.id !== groupRoom.you_id && <Button label="More" onPress={() => groupMemberOptions(member)} variant="quiet" />}
                  </View>
                ))}
              </View>
              <View style={styles.groupChat}>
                <Text style={styles.panelTitle}>Group chat</Text>
                <ScrollView ref={groupChatScrollRef} style={styles.groupMessageList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                  {groupMessages.length ? groupMessages.slice(-30).map((message) => {
                    const author = groupRoom.members.find((member) => member.id === message.author_id);
                    return (
                      <View key={message.id} style={[styles.roomMessage, message.author_id === user.id && styles.roomMessageMine]}>
                        <Text style={styles.roomMessageAuthor}>{message.author_id === user.id ? 'YOU' : `@${author?.anonymous_handle || 'MEMBER'}`}</Text>
                        <Text style={styles.roomMessageContent}>{message.content}</Text>
                      </View>
                    );
                  }) : <Text style={styles.muted}>No messages yet. Start with a small hello.</Text>}
                </ScrollView>
                <View style={styles.row}>
                  <View style={styles.flex}><Field value={groupMessageText} onChangeText={setGroupMessageText} placeholder="Say hi to the circle…" maxLength={1000} returnKeyType="send" onSubmitEditing={sendGroupMessage} /></View>
                  <Button label="Send" onPress={sendGroupMessage} disabled={busy || !groupMessageText.trim()} />
                </View>
              </View>
              <Button label="Leave this circle" onPress={leaveGroup} variant="danger" disabled={busy} />
            </View>
          ) : room ? (
            <>
              <View style={styles.roomMeta}>
                <Text style={styles.pill}>DAY {room.day_streak} / {room.unmask_day_threshold}</Text>
                <Text style={styles.muted}>{room.partner?.neighborhood_tag || user.neighborhood_tag} · room {room.room_id.slice(0, 5)}</Text>
              </View>
              {room.demo_companion && <Text style={styles.demoNote}>This companion is simulated for the local MVP. Real-person matching is not enabled.</Text>}
              {room.can_rematch && <View style={styles.inactiveBanner}>
                <Text style={styles.panelTitle}>This room has been quiet</Text>
                <Text style={styles.body}>Your companion has not checked in for about {room.partner_inactive_hours} hours. You can stay, or try a new connection.</Text>
                <Button label="Leave and find someone else" onPress={leaveAndRematch} variant="secondary" disabled={busy} />
              </View>}
              <View style={styles.roomCard}>
                <View style={[styles.roomCanvas, { backgroundColor: roomSoundtrack.scene }]}>
                  <View style={styles.canvasWindow}>
                    {room.assets.filter((asset) => asset.asset_type === 'polaroid' && asset.media_url).slice(-1).map((asset) => (
                      <Image
                        key={asset.id}
                        source={{
                          uri: asset.media_url?.startsWith('/api/v1/media/') ? `${API_URL}${asset.media_url}` : asset.media_url!,
                          headers: asset.media_url?.startsWith('/api/v1/media/') ? { Authorization: `Bearer ${token}` } : undefined,
                        }}
                        style={styles.mirrorImage}
                        resizeMode="cover"
                      />
                    ))}
                    {!room.assets.some((asset) => asset.asset_type === 'polaroid') && <Text style={styles.windowText}>✦</Text>}
                  </View>
                  <Text style={styles.canvasCaption}>a place to just be</Text>
                  {room.assets.filter((asset) => asset.asset_type === 'sticky_note').slice(-1).map((asset) => (
                    <View key={asset.id} style={styles.wallNote}>
                      <Text style={styles.wallNoteAuthor}>
                        @{asset.author_id === user.id ? user.anonymous_handle : room.partner?.anonymous_handle}
                      </Text>
                      <Text style={styles.wallNoteText} numberOfLines={4}>{asset.content}</Text>
                    </View>
                  ))}
                  <View style={styles.plantMarker}>
                    <Text style={[styles.plantEmoji, { fontSize: PLANT_STAGES[room.plant_growth.stage]?.size || PLANT_STAGES[0].size }]}>
                      {PLANT_STAGES[room.plant_growth.stage]?.emoji || PLANT_STAGES[0].emoji}
                    </Text>
                    <Text style={styles.plantCaption}>{PLANT_STAGES[room.plant_growth.stage]?.title || PLANT_STAGES[0].title}</Text>
                  </View>
                </View>
                <View style={styles.statsRow}>
                  <View style={styles.stat}>
                    <Text style={styles.statCaption}>SHARED DAYS</Text>
                    <Text style={styles.statValue}>{room.plant_growth.completed_days} / 3</Text>
                  </View>
                  <TouchableOpacity accessibilityRole="button" style={styles.stat} onPress={cycleRoomSoundtrack}>
                    <Text style={styles.statCaption}>ROOM SOUND · TAP TO CHANGE</Text>
                    <Text style={styles.statValue} numberOfLines={1}>{roomSoundtrack.title}</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <View style={styles.growthProgress}>
                <View style={styles.growthProgressCopy}>
                  <Text style={styles.dailyPromptEyebrow}>GROWING TOGETHER</Text>
                  <Text style={styles.muted}>{PLANT_STAGES[room.plant_growth.stage]?.detail || PLANT_STAGES[0].detail}</Text>
                </View>
                <View style={styles.growthSteps}>
                  {[1, 2, 3].map((stage) => <View key={stage} style={[styles.growthStep, room.plant_growth.completed_days >= stage && styles.growthStepComplete]} />)}
                </View>
              </View>
              <TouchableOpacity accessibilityRole="button" style={styles.roomChatPreview} onPress={() => setRoomChatOpen(true)}>
                <View style={styles.chatHeading}>
                  <View style={styles.flex}>
                    <Text style={styles.panelTitle}>Chat with @{room.partner?.anonymous_handle || 'your companion'}</Text>
                    <Text style={styles.muted} numberOfLines={1}>{roomMessages.at(-1)?.content || 'Say hello whenever you feel like it.'}</Text>
                  </View>
                  <Text style={[styles.presenceLabel, partnerOnline && styles.presenceOnline]}>{partnerOnline ? 'HERE NOW' : 'ASYNC'}</Text>
                </View>
                <Text style={styles.spotifyLink}>OPEN CHAT →</Text>
              </TouchableOpacity>
              <View style={styles.dailyPrompt}>
                <Text style={styles.dailyPromptEyebrow}>DAY {room.daily_prompt.day} · A SMALL RITUAL</Text>
                <Text style={styles.dailyPromptQuestion}>{room.daily_prompt.question}</Text>
                {room.daily_prompt.revealed ? (
                  <View style={styles.promptAnswers}>
                    <Text style={styles.promptAnswerLabel}>YOU</Text>
                    <Text style={styles.promptAnswerText}>{room.daily_prompt.my_answer}</Text>
                    <Text style={styles.promptAnswerLabel}>YOUR COMPANION</Text>
                    <Text style={styles.promptAnswerText}>{room.daily_prompt.partner_answer}</Text>
                  </View>
                ) : room.daily_prompt.my_answer ? (
                  <View style={styles.promptAnswers}>
                    <Text style={styles.promptAnswerLabel}>YOUR ANSWER</Text>
                    <Text style={styles.promptAnswerText}>{room.daily_prompt.my_answer}</Text>
                    <Text style={styles.muted}>It stays private until your companion replies.</Text>
                  </View>
                ) : (
                  <>
                    <Field
                      value={promptAnswer}
                      onChangeText={setPromptAnswer}
                      placeholder="Write whatever comes to mind…"
                      multiline
                      maxLength={240}
                    />
                    <Text style={styles.muted}>{promptAnswer.length}/240 · Your answer stays private until both reply.</Text>
                    <Button
                      label={busy ? 'Saving…' : 'Share today’s answer'}
                      onPress={answerDailyPrompt}
                      disabled={busy || !promptAnswer.trim()}
                    />
                  </>
                )}
              </View>
              <View style={styles.shareMoreCard}>
                <Text style={styles.dailyPromptEyebrow}>DAY 3 · CIRCLE IS A MUTUAL CHOICE</Text>
                {!room.share_more.available ? (
                  <Text style={styles.body}>Opens in {Math.max(0, 3 - room.days_elapsed)} day{3 - room.days_elapsed === 1 ? '' : 's'}. Your anonymous chat stays open meanwhile.</Text>
                ) : room.share_more.mutual ? (
                  <>
                    <Text style={styles.body}>You both chose to join each other’s Circle.</Text>
                    <View style={styles.vibeList}>{room.share_more.partner_vibe_tags.map((vibe) => <Text key={vibe} style={[styles.vibeChip, styles.vibeChipSelected]}>{vibe}</Text>)}</View>
                  </>
                ) : room.share_more.my_vote === 1 ? (
                  <Text style={styles.body}>Your choice is saved. You’ll both move to Circle when your companion also agrees.</Text>
                ) : (
                  <>
                    <Text style={styles.body}>After three days, you can choose to become friends. Your anonymous chat history comes with you; your vibe tags are shared only if you both agree.</Text>
                    <Button label="Join each other’s Circle" onPress={() => shareMore(true)} disabled={busy} />
                    <Button label="Keep it private for now" onPress={() => shareMore(false)} variant="quiet" disabled={busy} />
                  </>
                )}
              </View>
              <View style={styles.nudgeArea}>
                <Button label="Send a nudge" onPress={sendNudge} variant="secondary" disabled={busy} />
                <Text style={styles.muted}>A gentle buzz lets them know you’re around. No reply needed.</Text>
              </View>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Leave a little note</Text>
                <Field value={note} onChangeText={setNote} placeholder="Something you noticed today…" maxLength={140} multiline />
                <Text style={styles.muted}>{note.length}/140</Text>
                <Button label="Pin note to wall" onPress={postAsset} disabled={busy || !note.trim()} />
              </View>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Add a polaroid</Text>
                {photoUri ? <Image source={{ uri: photoUri }} style={styles.photoPreview} /> : null}
                <Text style={styles.muted}>Photos are resized and EXIF metadata is removed. One upload per day, max 2 MB. Automated image moderation is not configured.</Text>
                <Button label={photoUri ? 'Choose a different photo' : 'Choose a photo'} onPress={choosePhoto} variant="quiet" disabled={busy} />
                <Button label="Pin polaroid to wall" onPress={uploadPolaroid} disabled={busy || !photoBase64} />
              </View>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Things on your wall</Text>
                {room.assets.length ? room.assets.map((asset) => (
                  <View key={asset.id} style={styles.asset}>
                    <Text style={styles.assetType}>{asset.asset_type === 'sticky_note' ? 'NOTE' : 'POLAROID'} · @{asset.author_id === user.id ? user.anonymous_handle : room.partner?.anonymous_handle}</Text>
                    {asset.asset_type === 'sticky_note'
                      ? <Text style={styles.assetText}>{asset.content}</Text>
                      : asset.media_url?.startsWith('/api/v1/media/')
                        ? <Image source={{ uri: `${API_URL}${asset.media_url}`, headers: { Authorization: `Bearer ${token}` } }} style={styles.photoPreview} />
                        : asset.media_url
                          ? <Image source={{ uri: asset.media_url }} style={styles.photoPreview} />
                          : null}
                  </View>
                )) : <Text style={styles.muted}>The wall is waiting for its first memory.</Text>}
              </View>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Spotify for this room</Text>
                <View style={styles.soundModeRow}>
                  <View style={styles.flex}>
                    <Text style={styles.assetText}>{roomSoundtrack.title}</Text>
                    <Text style={styles.muted}>{selectedSpotifyUrl ? 'Spotify is selected; room ambience is paused.' : roomSoundtrack.subtitle}</Text>
                  </View>
                  <Switch
                    accessibilityLabel="Room ambience"
                    value={ambientEnabled}
                    onValueChange={setAmbientEnabled}
                    trackColor={{ false: '#35435e', true: '#438975' }}
                    thumbColor={ambientEnabled ? '#a9f0d7' : '#c0cbe0'}
                  />
                </View>
                {selectedSpotifyUrl ? (
                  <>
                    <WebView
                      source={{ uri: spotifyEmbedUrl(selectedSpotifyUrl)! }}
                      style={styles.spotifyPlayer}
                      originWhitelist={['https://*']}
                      javaScriptEnabled
                      domStorageEnabled
                      allowsInlineMediaPlayback
                      mediaPlaybackRequiresUserAction
                    />
                    <Text style={styles.muted}>Spotify · {spotifyMetadata?.author_name || 'Playback stays on this device.'} Full tracks depend on your Spotify account and region.</Text>
                    <TouchableOpacity accessibilityRole="link" onPress={() => Linking.openURL(selectedSpotifyUrl)}>
                      <Text style={styles.spotifyLink}>View on Spotify</Text>
                    </TouchableOpacity>
                    <Button label="Use room ambience instead" onPress={clearSpotifyTrack} variant="quiet" disabled={busy} />
                  </>
                ) : null}
                <View style={styles.spotifyConnectHeader}>
                  <View style={styles.flex}>
                    <Text style={styles.assetText}>Your Spotify top 3</Text>
                    <Text style={styles.muted}>Only a track you choose is shared with the room.</Text>
                  </View>
                  <Button
                    label={spotifyLoading ? 'Loading…' : spotifySession ? 'Refresh top 3' : 'Connect Spotify'}
                    onPress={spotifySession ? () => setSpotifyReloadKey((current) => current + 1) : connectSpotify}
                    variant="quiet"
                    disabled={spotifyLoading || busy}
                  />
                </View>
                {!SPOTIFY_CLIENT_ID ? <Text style={styles.muted}>Spotify setup required: add a Client ID and use a development build.</Text> : null}
                {spotifyStatus ? <Text style={styles.muted}>{spotifyStatus}</Text> : null}
                {spotifyTracks.map((spotifyTrack) => (
                  <TouchableOpacity key={spotifyTrack.id} accessibilityRole="button" onPress={() => selectSpotifyTrack(spotifyTrack)} style={styles.spotifyTrackRow}>
                    {spotifyTrack.album.images[2]?.url || spotifyTrack.album.images[0]?.url
                      ? <Image source={{ uri: spotifyTrack.album.images[2]?.url || spotifyTrack.album.images[0]?.url }} style={styles.spotifyTrackArtwork} />
                      : <View style={styles.spotifyTrackArtworkFallback}><Text style={styles.vibeText}>♫</Text></View>}
                    <View style={styles.flex}>
                      <Text style={styles.spotifyTrackTitle} numberOfLines={1}>{spotifyTrack.name}</Text>
                      <Text style={styles.muted} numberOfLines={1}>{spotifyTrack.artists.map((artist) => artist.name).join(', ')}</Text>
                    </View>
                    <Text style={styles.spotifyTrackAction}>SET</Text>
                  </TouchableOpacity>
                ))}
                {spotifySession ? <Button label="Remove Spotify connection" onPress={removeSpotifyConnection} variant="quiet" disabled={busy || spotifyLoading} /> : null}
                <View style={styles.row}>
                  <View style={styles.flex}><Field value={spotifyLink} onChangeText={setSpotifyLink} placeholder="Paste a Spotify share link" autoCapitalize="none" keyboardType="url" /></View>
                  <Button label="Set" onPress={changeTrack} variant="quiet" disabled={busy || !spotifyLink.trim()} />
                </View>
                <Text style={styles.muted}>Spotify’s player opens here; press play to listen. Playback isn’t shared between devices.</Text>
              </View>
              <Button label="Report a safety concern" onPress={reportSafetyConcern} variant="quiet" disabled={busy} />
              <Button label="Block and leave this room" onPress={blockPartner} variant="danger" disabled={busy} />
              <Button label="Leave this room" onPress={dissolveRoom} variant="danger" disabled={busy} />
            </>
          ) : matching ? (
            <View style={styles.searchingState}>
              <ActivityIndicator size="large" color="#76e1bd" />
              <Text style={styles.heading}>Looking for someone nearby.</Text>
                <Text style={styles.body}>One-to-one matching is within 5 km. A 3–4 person group can form after two minutes when at least three real people are waiting within 15 km.</Text>
              <Text style={styles.muted}>No simulated people are added to the queue.</Text>
                {__DEV__ && Platform.OS === 'android' ? <Button label="Use Pune test location · development only" onPress={usePuneTestLocation} variant="quiet" disabled={busy} /> : null}
              <Button label="Cancel search" onPress={cancelMatchSearch} variant="quiet" disabled={busy} />
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyArt}>☼</Text>
              <Text style={styles.heading}>Meet someone nearby.</Text>
              <Text style={styles.body}>We’ll look for one real person first. If nobody is available, you can join a small group when three or more people are waiting nearby.</Text>
              <View style={styles.panel}>
                <Text style={styles.label}>YOUR COARSE AREA</Text>
                <Text style={styles.assetText}>{user.neighborhood_tag || 'Set your profile first'}</Text>
                <Text style={styles.muted}>Matching coordinates stay private and must be inside the Pune service area.</Text>
              </View>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Button label={busy ? 'Finding your companion…' : 'Find a companion'} onPress={findCompanion} disabled={busy || user.latitude == null || user.longitude == null} />
              {__DEV__ && Platform.OS === 'android' ? <Button label="Use Pune test location · development only" onPress={usePuneTestLocation} variant="quiet" disabled={busy} /> : null}
            </View>
          )}
        </ScrollView>
      )}
      {tab === 'circle' && (
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          {friendships.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.heading}>Not quite yet.</Text>
              <Text style={styles.body}>Your circle appears when both people choose to unmask on day 10.</Text>
              <Button label="Back to room" onPress={() => setTab('room')} />
            </View>
          ) : (
            friendships.map((friendship) => (
              <TouchableOpacity key={friendship.friendship_id} style={styles.friendCard} onPress={() => setSelectedFriendship(friendship.friendship_id)}>
                <Text style={styles.friendName}>@{friendship.anonymous_handle}</Text>
                <Text style={styles.muted}>{friendship.neighborhood_tag} · Tap to open your conversation</Text>
                {friendship.verification_tier === 'demo' && <Text style={styles.demoNote}>Simulated companion · demo messages are not a real person.</Text>}
              </TouchableOpacity>
            ))
          )}
          {selectedFriendship && (
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>Your conversation</Text>
              <ScrollView ref={circleChatScrollRef} style={styles.circleMessageList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                {messages.map((message) => (
                <View key={message.id} style={[styles.message, message.author_id === user.id && styles.myMessage]}>
                  <Text style={styles.assetText}>{message.content}</Text>
                  <Text style={styles.chatTimestamp}>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                </View>
                ))}
              </ScrollView>
              <Field value={messageText} onChangeText={setMessageText} placeholder="Say hello…" multiline maxLength={2000} />
              <Button label="Send message" onPress={sendMessage} disabled={busy || !messageText.trim()} />
            </View>
          )}
        </ScrollView>
      )}
      {tab === 'profile' && (
        <ScrollView contentContainerStyle={styles.page}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>@{user.anonymous_handle}</Text>
            <Text style={styles.body}>{user.neighborhood_tag}</Text>
            <Text style={styles.muted}>{user.phone_number}</Text>
            <Text style={styles.muted}>Phone verification: demo-only OTP · Identity liveness: not configured</Text>
          </View>
          {room && <Button label="Decline & dissolve room" onPress={() => voteToUnmask(false)} variant="danger" disabled={busy} />}
          <Button label="Sign out" onPress={signOut} variant="quiet" disabled={busy} />
          <Text style={styles.demoNote}>Prototype notice: the local OTP is not SMS verification. Do not use real phone numbers or sensitive personal data.</Text>
        </ScrollView>
      )}
      {!roomChatOpen && <View style={styles.tabBar}>
        {(['room', 'circle', 'profile'] as const).map((item) => (
          <TouchableOpacity key={item} onPress={() => setTab(item)} style={styles.tab}>
            <Text style={[styles.tabText, tab === item && styles.tabTextActive]}>{item === 'room' ? 'ROOM' : item === 'circle' ? 'CIRCLE' : 'YOU'}</Text>
          </TouchableOpacity>
        ))}
      </View>}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: '#0c1020' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0c1020' },
  page: { padding: 20, paddingBottom: 36, gap: 14 },
  authPage: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 12 },
  header: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: '#76e1bd', fontSize: 11, fontWeight: '800', letterSpacing: 2 },
  hero: { color: '#f3f6ff', fontSize: 42, lineHeight: 48, fontWeight: '800', marginTop: 12 },
  heading: { color: '#f3f6ff', fontSize: 28, fontWeight: '800' },
  headerTitle: { color: '#f3f6ff', fontSize: 23, fontWeight: '800', marginTop: 5 },
  handle: { color: '#bac8e6', fontSize: 13 },
  body: { color: '#a9b7d6', fontSize: 15, lineHeight: 23 },
  muted: { color: '#8795b2', fontSize: 12, lineHeight: 18 },
  label: { color: '#a9b7d6', fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginTop: 8 },
  input: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: '#293650', backgroundColor: '#111a2c', color: '#f3f6ff', paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  button: { minHeight: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 13 },
  button_primary: { backgroundColor: '#76e1bd' },
  button_secondary: { backgroundColor: '#f5c26b' },
  button_quiet: { backgroundColor: '#202d47' },
  button_danger: { backgroundColor: '#512f42' },
  buttonDisabled: { opacity: 0.48 },
  buttonText: { fontSize: 14, fontWeight: '800' },
  buttonText_primary: { color: '#08170f' },
  buttonText_secondary: { color: '#23190d' },
  buttonText_quiet: { color: '#e2eaff' },
  buttonText_danger: { color: '#ffdbe4' },
  disclaimer: { color: '#7886a2', fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 16 },
  error: { color: '#ff9eab', fontSize: 13, lineHeight: 19 },
  errorBanner: { color: '#ffdce2', backgroundColor: '#512f42', paddingHorizontal: 16, paddingVertical: 9, marginHorizontal: 16, borderRadius: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  locationBlock: { gap: 9 },
  vibeList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  vibeChip: { minHeight: 38, justifyContent: 'center', borderRadius: 999, paddingHorizontal: 13, backgroundColor: '#202d47', borderWidth: 1, borderColor: '#35435e' },
  vibeChipSelected: { backgroundColor: '#244b43', borderColor: '#76e1bd' },
  vibeText: { color: '#c0cbe0', fontSize: 13, fontWeight: '600' },
  vibeTextSelected: { color: '#a9f0d7' },
  roomMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pill: { color: '#101a28', fontSize: 11, fontWeight: '900', letterSpacing: 1, backgroundColor: '#76e1bd', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  demoNote: { color: '#e8c98e', backgroundColor: '#392f23', borderRadius: 12, padding: 12, fontSize: 12, lineHeight: 18 },
  roomCard: { backgroundColor: '#152039', borderColor: '#263653', borderWidth: 1, borderRadius: 22, padding: 12 },
  roomCanvas: { height: 225, overflow: 'hidden', borderRadius: 16, backgroundColor: '#eadfd1', justifyContent: 'center', alignItems: 'center' },
  wallNote: { position: 'absolute', left: 18, top: 54, width: 142, minHeight: 82, padding: 10, borderRadius: 3, backgroundColor: '#f6df8a', transform: [{ rotate: '-2deg' }], shadowColor: '#000000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.16, shadowRadius: 4, elevation: 3 },
  wallNoteAuthor: { color: '#746746', fontSize: 8, fontWeight: '800', marginBottom: 5 },
  wallNoteText: { color: '#403927', fontSize: 12, lineHeight: 16 },
  photoPreview: { width: '100%', height: 210, borderRadius: 12, backgroundColor: '#202f4a' },
  canvasWindow: { position: 'absolute', right: 28, top: 22, width: 72, height: 86, overflow: 'hidden', borderRadius: 8, borderWidth: 5, borderColor: '#c7ae8d', backgroundColor: '#b2d0cf', alignItems: 'center', justifyContent: 'center' },
  mirrorImage: { width: '100%', height: '100%' },
  windowText: { color: '#fff7dc', fontSize: 32 },
  canvasCaption: { color: '#756557', position: 'absolute', top: 18, left: 16, fontSize: 12, fontStyle: 'italic' },
  plantMarker: { position: 'absolute', bottom: 12, left: 26, alignItems: 'center', gap: 1 },
  plantEmoji: { lineHeight: 64 },
  plantCaption: { color: '#594e42', fontSize: 9, fontWeight: '700' },
  statsRow: { flexDirection: 'row', gap: 10, paddingTop: 12 },
  stat: { flex: 1, backgroundColor: '#202f4a', borderRadius: 13, padding: 12 },
  statCaption: { color: '#9bb0d5', fontSize: 9, letterSpacing: 1.2, fontWeight: '800' },
  statValue: { color: '#f5f7ff', fontSize: 16, fontWeight: '700', marginTop: 7 },
  panel: { backgroundColor: '#121d35', borderRadius: 16, padding: 16, gap: 10, borderWidth: 1, borderColor: '#202e49' },
  roomSoundtrack: { gap: 10, paddingTop: 12 },
  growthProgress: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  growthProgressCopy: { flex: 1, gap: 4 },
  growthSteps: { width: 76, flexDirection: 'row', gap: 4 },
  growthStep: { flex: 1, height: 5, borderRadius: 3, backgroundColor: '#293650' },
  growthStepComplete: { backgroundColor: '#76e1bd' },
  roomChat: { backgroundColor: '#121d35', borderRadius: 16, padding: 16, gap: 12, borderWidth: 1, borderColor: '#202e49' },
  roomChatPreview: { backgroundColor: '#121d35', borderRadius: 16, padding: 16, gap: 10, borderWidth: 1, borderColor: '#202e49' },
  chatScreen: { flex: 1, backgroundColor: '#e8e5df' },
  chatTopBar: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, backgroundColor: '#152039' },
  chatBackButton: { paddingVertical: 10, paddingRight: 4 },
  chatHistory: { flex: 1 },
  circleMessageList: { maxHeight: 330 },
  chatHistoryContent: { paddingHorizontal: 13, paddingVertical: 14, gap: 8 },
  chatDayNotice: { alignSelf: 'center', color: '#56634f', backgroundColor: '#f4f0df', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7, fontSize: 10, fontWeight: '700', overflow: 'hidden', marginBottom: 8 },
  whatsappBubble: { maxWidth: '84%', borderRadius: 16, paddingHorizontal: 12, paddingTop: 9, paddingBottom: 6, gap: 4 },
  whatsappBubbleMine: { alignSelf: 'flex-end', backgroundColor: '#d8f1df', borderBottomRightRadius: 5 },
  whatsappBubbleTheirs: { alignSelf: 'flex-start', backgroundColor: '#ffffff', borderBottomLeftRadius: 5 },
  chatTimestamp: { alignSelf: 'flex-end', color: '#6e7b70', fontSize: 9, marginTop: 2 },
  chatEmptyHint: { alignSelf: 'center', alignItems: 'center', gap: 5, backgroundColor: '#f4f0df', borderRadius: 12, padding: 14, marginTop: 22 },
  chatComposer: { flexDirection: 'row', alignItems: 'flex-end', gap: 9, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: '#f3f1ec', borderTopWidth: 1, borderTopColor: '#d5d2ca' },
  chatInput: { minHeight: 44, maxHeight: 110, borderRadius: 22, borderColor: '#d0d3cc', backgroundColor: '#ffffff', color: '#24312b', paddingHorizontal: 16 },
  chatSendButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#368c70' },
  chatSendText: { color: '#ffffff', fontSize: 22, fontWeight: '800', marginTop: -2 },
  nudgeArea: { alignItems: 'flex-start', gap: 7 },
  chatHeading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  presenceLabel: { color: '#8795b2', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  presenceOnline: { color: '#9bd9c2' },
  roomMessageList: { maxHeight: 220 },
  roomMessage: { alignSelf: 'flex-start', maxWidth: '90%', backgroundColor: '#202f4a', borderRadius: 12, padding: 10, marginBottom: 7, gap: 5 },
  roomMessageMine: { alignSelf: 'flex-end', backgroundColor: '#285747' },
  roomMessageContent: { color: '#edf2ff', fontSize: 14, lineHeight: 20 },
  roomMessageAuthor: { color: '#a9b7d6', fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  shareMoreCard: { backgroundColor: '#172a35', borderRadius: 16, padding: 16, gap: 12, borderWidth: 1, borderColor: '#31504d' },
  inactiveBanner: { backgroundColor: '#392f23', borderRadius: 12, padding: 14, gap: 10 },
  soundModeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  spotifyConnectHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 4 },
  spotifyTrackRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: '#293650', paddingVertical: 7 },
  spotifyTrackArtwork: { width: 44, height: 44, borderRadius: 4, backgroundColor: '#202f4a' },
  spotifyTrackArtworkFallback: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: '#202f4a' },
  spotifyTrackTitle: { color: '#f3f6ff', fontSize: 13, fontWeight: '700' },
  spotifyTrackAction: { color: '#9bd9c2', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  spotifyPlayer: { height: 152, backgroundColor: '#101814', borderRadius: 8 },
  spotifyLink: { color: '#9bd9c2', fontSize: 12, fontWeight: '700' },
  dailyPrompt: { backgroundColor: '#172a35', borderRadius: 16, padding: 16, gap: 12, borderWidth: 1, borderColor: '#31504d' },
  dailyPromptEyebrow: { color: '#9bd9c2', fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  dailyPromptQuestion: { color: '#f3f6ff', fontSize: 20, lineHeight: 28, fontWeight: '700' },
  promptAnswers: { borderTopWidth: 1, borderTopColor: '#31504d', paddingTop: 12, gap: 7 },
  promptAnswerLabel: { color: '#9bd9c2', fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  promptAnswerText: { color: '#f3f6ff', fontSize: 15, lineHeight: 22, marginBottom: 8 },
  panelTitle: { color: '#f3f6ff', fontSize: 17, fontWeight: '800' },
  asset: { paddingVertical: 12, borderTopColor: '#293650', borderTopWidth: 1, gap: 6 },
  assetType: { color: '#76e1bd', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  assetText: { color: '#edf2ff', fontSize: 15, lineHeight: 21 },
  emptyState: { flex: 1, minHeight: 460, justifyContent: 'center', gap: 16 },
  searchingState: { flex: 1, minHeight: 460, justifyContent: 'center', alignItems: 'flex-start', gap: 16 },
  groupExperience: { gap: 16 },
  groupIntro: { gap: 9, paddingVertical: 12 },
  groupMembers: { backgroundColor: '#121d35', borderRadius: 16, padding: 16, gap: 12, borderWidth: 1, borderColor: '#202e49' },
  groupMemberRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: 1, borderTopColor: '#293650', paddingTop: 8 },
  groupChat: { backgroundColor: '#121d35', borderRadius: 16, padding: 16, gap: 12, borderWidth: 1, borderColor: '#202e49' },
  groupMessageList: { maxHeight: 360 },
  emptyArt: { color: '#76e1bd', fontSize: 60 },
  friendCard: { backgroundColor: '#152039', borderRadius: 15, padding: 16, gap: 6 },
  friendName: { color: '#f3f6ff', fontSize: 17, fontWeight: '800' },
  message: { backgroundColor: '#202f4a', borderRadius: 12, padding: 12, gap: 5, alignSelf: 'flex-start', maxWidth: '90%' },
  myMessage: { backgroundColor: '#285747', alignSelf: 'flex-end' },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#202e49', backgroundColor: '#10182a', paddingBottom: Platform.OS === 'ios' ? 4 : 0 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  tabText: { color: '#77839a', fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  tabTextActive: { color: '#76e1bd' },
});
