import { useEffect, useRef, useState } from 'react';
import { getApiClient } from '@/lib/api';
import { formatSafeError } from '@lumibase/shared/utils';

export function useRealtimeSubscription(collection: string, onUpdate?: (payload: any) => void) {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const client = getApiClient();

  useEffect(() => {
    let isMounted = true;

    // In a real application, we would pass the active siteId.
    // For this stub, we just pass 'default'.
    const ws = client.realtime.connect('default').then((ws) => {
      if (!isMounted) {
        ws.close();
        return;
      }
    });
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      // Subscribe to the specific collection
      ws.send(JSON.stringify({ type: 'subscribe', collection }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.collection === collection && onUpdate) {
          onUpdate(data);
        }
      } catch (err) {
        console.error('Failed to parse realtime message:', formatSafeError(err));
      }
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        // Subscribe to the specific collection
        ws.send(JSON.stringify({ type: 'subscribe', collection }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.collection === collection && onUpdate) {
            onUpdate(data);
          }
        } catch (err) {
          console.error('Failed to parse realtime message:', err);
        }
      };

      ws.onerror = (event) => {
        setError(new Error('WebSocket error'));
      };

      ws.onclose = () => {
        setIsConnected(false);
      };
    }).catch(err => {
      console.error('Failed to connect to realtime:', err);
      if (isMounted) setError(err);
    });

    return () => {
      isMounted = false;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [collection, client.realtime, onUpdate]);

  return { isConnected, error };
}
