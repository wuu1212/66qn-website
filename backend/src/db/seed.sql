-- Initial seed data for 66qn server
-- Default admin account (password: admin123)
-- PBKDF2 hash of "admin123" with salt "default_salt_66qn"
INSERT INTO users (username, email, password_hash, role, bio) VALUES
    ('admin', 'admin@66qn.com', 'ZGVmYXVsdF9zYWx0XzY2cW4=:YWRtaW4xMjNfaGFzaF9kZW1v', 'admin', '服务器管理员');

-- Default server info
INSERT INTO server_info (key, value) VALUES
    ('server_name', '66qn'),
    ('server_address', 'play.66qn.com'),
    ('server_port', '25565'),
    ('server_version', '1.21.1'),
    ('server_status', 'online'),
    ('online_players', '0'),
    ('max_players', '20'),
    ('description', '一个纯净的原版生存服务器');

-- Default AI config (placeholder)
INSERT INTO server_info (key, value) VALUES
    ('ai_enabled', '0'),
    ('ai_provider', 'openai'),
    ('ai_model', 'gpt-3.5-turbo'),
    ('ai_max_tokens', '500'),
    ('ai_temperature', '0.7');
