// Group chat uses conversation models; specialized image/audio/embedding models
// cannot be selected through either the picker or a crafted request.
export const isChatModel = model => !/(?:image|dall-e|sora|video|audio|tts|whisper|embed|moderation|realtime)/i.test(String(model.id || model.model || '') + ' ' + String(model.name || ''));
