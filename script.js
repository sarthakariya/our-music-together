// --- FIREBASE SYNC (REALTIME DATABASE) ---

function loadInitialData() {
    // 1. Queue Listener (MUST be loaded first for data integrity)
    queueRef.on('value', (snapshot) => {
        const queueData = snapshot.val();
        currentQueue = [];
        if (queueData) {
            Object.keys(queueData).forEach(key => {
                currentQueue.push({ ...queueData[key], key: key });
            });
        }
        renderQueue(currentQueue, currentVideoId);
    });

    // 2. Sync Command Listener (MUST be loaded for playback control)
    syncRef.on('value', (snapshot) => {
        const syncState = snapshot.val();
        lastSyncState = syncState; 

        if (syncState) {
            lastBroadcaster = syncState.lastUpdater; 

            if (syncState.lastUpdater !== myName) {
                applyRemoteCommand(syncState);
            }
        } else {
             // If the sync node is cleared/empty, ensure the overlay is off
             document.getElementById('syncOverlay').classList.remove('active');
        }
        
        // Update overlay display based on stored state
        if (document.getElementById('syncOverlay').classList.contains('active')) {
             document.getElementById('overlayTitle').textContent = `Awaiting ${lastBroadcaster} to resume...`;
             document.getElementById('overlayText').innerHTML = `Playback paused due to a **${lastBroadcaster}** Ad/Buffer stall. You cannot resume playback until they do.`;
        }
        
        updateSyncStatus();
    });

    // 3. Chat Listener
    chatRef.limitToLast(20).on('child_added', (snapshot) => {
        const message = snapshot.val();
        displayChatMessage(message.user, message.text, message.timestamp);
    });
}

function applyRemoteCommand(state) {
    if (!player || !state || state.videoId === undefined) return;
    
    const partnerIsPlaying = state.action === 'play';
    isPartnerPlaying = true; 

    // **CRITICAL AD STALL LOGIC ENFORCEMENT**
    if (!partnerIsPlaying && state.isAdStall) {
         // Immediate, overriding pause for Ad/Buffer Stall
         document.getElementById('syncOverlay').classList.add('active');
         if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            player.pauseVideo();
         }
         return; // STOP processing anything else if it's a strict Ad Stall pause command
    }
    // **END CRITICAL AD STALL LOGIC ENFORCEMENT**


    if (state.videoId !== currentVideoId) {
        // NEW SONG OR DIFFERENT SONG IN SYNC
        const song = currentQueue.find(s => s.videoId === state.videoId);
        const title = song ? song.title : 'External Sync';

        player.loadVideoById(state.videoId, state.time);
        currentVideoId = state.videoId;
        document.getElementById('current-song-title').textContent = title;
        renderQueue(currentQueue, currentVideoId);
        
    } else if (state.action === 'seek') {
        player.seekTo(state.time, true);

    } else {
        // TIME CORRECTION
        const timeDiff = Math.abs(player.getCurrentTime() - state.time);
        if (timeDiff > 2) {
            player.seekTo(state.time, true);
        }
    }
    
    // Play/Pause Command Logic (Non-Ad-Stall)
    if (partnerIsPlaying) {
        // Partner is playing, hide the lock screen and ensure we play
        document.getElementById('syncOverlay').classList.remove('active');
        if (player.getPlayerState() !== YT.PlayerState.PLAYING) {
            player.playVideo();
        }
    } else {
        // Manual pause, seeking pause, or end of song pause - remove the lock screen
        document.getElementById('syncOverlay').classList.remove('active');
        
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            player.pauseVideo();
        }
    }
}
