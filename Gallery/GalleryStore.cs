using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;
using SwarmUI.Core;
using SwarmUI.Utils;
using System.IO;

using ISImage = SixLabors.ImageSharp.Image;

namespace PromptGallery;

/// <summary>File-based storage for the prompt gallery.
/// Layout: <c>Data/PromptGallery/(profile)/(folders...)/(card).txt</c> + an image with the same base name.
/// A card is any base name that has a <c>.txt</c> and/or an image file.</summary>
public static class GalleryStore
{
    /// <summary>Thrown for user-facing validation errors (message is safe to show).</summary>
    public class GalleryException(string message) : Exception(message)
    {
    }

    /// <summary>Image extensions recognized as card images, in priority order.</summary>
    public static readonly string[] ImageExtensions = ["png", "jpg", "jpeg", "webp"];

    /// <summary>Mime types accepted on upload, mapped to the extension used on disk.</summary>
    public static readonly Dictionary<string, string> UploadMimeToExt = new()
    {
        ["image/png"] = "png",
        ["image/jpeg"] = "jpg",
        ["image/jpg"] = "jpg",
        ["image/webp"] = "webp"
    };

    /// <summary>Separators a profile may use when joining cards into a prompt.</summary>
    public static readonly string[] AllowedSeparators = [", ", ". ", "\n", " "];

    public const string ProfileFileName = "profile.json";

    public const int ThumbnailSize = 384;

    /// <summary>Max accepted size of an uploaded image data string (characters).</summary>
    public const int MaxUploadChars = 40 * 1024 * 1024;

    /// <summary>Max size of a card prompt text.</summary>
    public const int MaxPromptChars = 64 * 1024;

    static readonly HashSet<string> ReservedNames = ["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"];

    static readonly HashSet<char> BadNameChars = [.. Path.GetInvalidFileNameChars(), '/', '\\', ':', '*', '?', '"', '<', '>', '|'];

    /// <summary>Guards all write operations. Writes are rare and quick, so a single lock is fine.</summary>
    public static readonly object WriteLock = new();

    public static readonly UTF8Encoding Utf8NoBom = new(false);

    /// <summary>Root folder of all gallery data.</summary>
    public static string Root => Path.GetFullPath(Utilities.CombinePathWithAbsolute(Program.DataDir, "PromptGallery"));

    /// <summary>Folder of cached thumbnails (hidden from listings since it starts with a dot).</summary>
    public static string CacheRoot => Path.Combine(Root, ".cache", "thumbs");

    #region Path safety

    /// <summary>Validates a single file/folder name segment. Returns the trimmed name, or null if invalid.</summary>
    public static string CleanSegment(string name)
    {
        if (name is null)
        {
            return null;
        }
        name = name.Trim();
        if (name.Length == 0 || name.Length > 120 || name.StartsWith('.') || name.EndsWith('.') || name.Any(c => c < 32 || BadNameChars.Contains(c)))
        {
            return null;
        }
        string stem = name.Contains('.') ? name[..name.IndexOf('.')] : name;
        if (ReservedNames.Contains(stem.ToLowerInvariant()))
        {
            return null;
        }
        return name;
    }

    /// <summary>Validates a relative 'a/b/c' path. Returns the normalized path, or throws.</summary>
    public static string CleanRelPath(string path, bool allowEmpty, string what = "path")
    {
        string[] parts = (path ?? "").Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0)
        {
            if (allowEmpty)
            {
                return "";
            }
            throw new GalleryException($"The {what} must not be empty.");
        }
        if (parts.Length > 16)
        {
            throw new GalleryException($"The {what} is nested too deeply.");
        }
        foreach (string part in parts)
        {
            if (CleanSegment(part) is null)
            {
                throw new GalleryException($"Invalid name '{part}' in {what}. Names cannot start or end with a dot or contain any of: \\ / : * ? \" < > |");
            }
        }
        return string.Join('/', parts);
    }

    /// <summary>Combines a base dir with a validated relative path, and verifies the result stays inside the base dir.</summary>
    public static string Resolve(string baseDir, string rel)
    {
        string baseFull = Path.GetFullPath(baseDir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string full = Path.GetFullPath(Path.Combine(baseFull, rel));
        if (!(full + Path.DirectorySeparatorChar).StartsWith(baseFull, StringComparison.OrdinalIgnoreCase))
        {
            throw new GalleryException("Invalid path.");
        }
        return full;
    }

    /// <summary>Returns the folder of an existing profile, or throws.</summary>
    public static string ProfileDir(string profile)
    {
        string name = CleanSegment(profile) ?? throw new GalleryException("Invalid profile name.");
        string dir = Resolve(Root, name);
        if (!Directory.Exists(dir))
        {
            throw new GalleryException($"Profile '{name}' does not exist.");
        }
        return dir;
    }

    public static string ToRel(string baseDir, string full) => Path.GetRelativePath(baseDir, full).Replace('\\', '/');

    public static bool IsHiddenRel(string rel) => rel.Split('/').Any(p => p.StartsWith('.'));

    #endregion

    #region Profiles

    /// <summary>Per-profile settings, stored as profile.json in the profile folder.</summary>
    public class ProfileSettings
    {
        [JsonProperty("separator")]
        public string Separator = ", ";

        [JsonProperty("description")]
        public string Description = "";

        /// <summary>Prompt used by "Generate Preview"; "{card}" is replaced by the card text.</summary>
        [JsonProperty("preview_template")]
        public string PreviewTemplate = DefaultPreviewTemplate;

        /// <summary>Seed for preview generation, the same for every card so previews compare fairly. -1 = random.</summary>
        [JsonProperty("preview_seed")]
        public long PreviewSeed = DefaultPreviewSeed;

        /// <summary>Longest side, in pixels, of preview images saved to cards (they are scaled down to keep packs small). 0 = keep the generated size.</summary>
        [JsonProperty("preview_size")]
        public int PreviewSize = DefaultPreviewSize;

        /// <summary>Per-folder preview prompts (folder path to template), overriding <see cref="PreviewTemplate"/> for that folder and its subfolders.</summary>
        [JsonProperty("folder_templates")]
        public Dictionary<string, string> FolderTemplates = [];

        /// <summary>Aspect ratio of generated previews, eg "2:3". Empty = use the Generate tab's.</summary>
        [JsonProperty("preview_aspect")]
        public string PreviewAspect = "";

        /// <summary>Per-folder preview aspect ratios (folder path to ratio), overriding <see cref="PreviewAspect"/> for that folder and its subfolders.</summary>
        [JsonProperty("folder_aspects")]
        public Dictionary<string, string> FolderAspects = [];
    }

    /// <summary>The aspect ratios a preview can use (the same list as Swarm's Aspect Ratio parameter).</summary>
    public static readonly string[] AllowedAspects = ["1:1", "4:3", "3:2", "8:5", "16:9", "21:9", "3:4", "2:3", "5:8", "9:16", "9:21"];

    /// <summary>Returns a known aspect ratio, "" for empty, or null when the value is not a known ratio.</summary>
    public static string CleanAspect(string aspect)
    {
        aspect = (aspect ?? "").Trim();
        return aspect == "" ? "" : AllowedAspects.FirstOrDefault(a => a == aspect);
    }

    /// <summary>Validates folder aspect ratios from a file or pack: drops bad folder paths and unknown ratios.</summary>
    public static Dictionary<string, string> NormalizeFolderAspects(Dictionary<string, string> raw)
    {
        Dictionary<string, string> result = new(StringComparer.OrdinalIgnoreCase);
        if (raw is null)
        {
            return result;
        }
        foreach ((string folder, string aspect) in raw)
        {
            string key;
            try
            {
                key = CleanRelPath(folder, false, "folder");
            }
            catch (GalleryException)
            {
                continue;
            }
            string clean = CleanAspect(aspect);
            if (string.IsNullOrEmpty(clean) || IsHiddenRel(key))
            {
                continue;
            }
            result[key] = clean;
        }
        return result;
    }

    /// <summary>The preview aspect ratio that applies to a folder: its own, else the nearest parent folder's, else the profile's.</summary>
    public static string EffectiveAspect(ProfileSettings settings, string folder)
    {
        string current = folder ?? "";
        while (current != "")
        {
            if (settings.FolderAspects.TryGetValue(current, out string aspect))
            {
                return aspect;
            }
            int slash = current.LastIndexOf('/');
            current = slash < 0 ? "" : current[..slash];
        }
        return settings.PreviewAspect;
    }

    /// <summary>Validates folder templates from a file or pack: drops bad folder paths and templates without {card}.</summary>
    public static Dictionary<string, string> NormalizeFolderTemplates(Dictionary<string, string> raw)
    {
        Dictionary<string, string> result = new(StringComparer.OrdinalIgnoreCase);
        if (raw is null)
        {
            return result;
        }
        foreach ((string folder, string template) in raw)
        {
            string key;
            try
            {
                key = CleanRelPath(folder, false, "folder");
            }
            catch (GalleryException)
            {
                continue;
            }
            if (string.IsNullOrWhiteSpace(template) || !template.Contains("{card}") || template.Length > MaxPromptChars || IsHiddenRel(key))
            {
                continue;
            }
            result[key] = template.Trim();
        }
        return result;
    }

    /// <summary>The preview template that applies to a folder: its own, else the nearest parent folder's, else the profile's.</summary>
    public static string EffectiveTemplate(ProfileSettings settings, string folder)
    {
        string current = folder ?? "";
        while (current != "")
        {
            if (settings.FolderTemplates.TryGetValue(current, out string template))
            {
                return template;
            }
            int slash = current.LastIndexOf('/');
            current = slash < 0 ? "" : current[..slash];
        }
        return settings.PreviewTemplate;
    }

    public static void SaveProfileSettings(string profileDir, ProfileSettings settings) =>
        File.WriteAllText(Path.Combine(profileDir, ProfileFileName), JsonConvert.SerializeObject(settings, Formatting.Indented), Utf8NoBom);

    public const string DefaultPreviewTemplate = "{card}";

    public const long DefaultPreviewSeed = 1;

    public const int DefaultPreviewSize = 512;

    /// <summary>Clamps preview settings to sane values: seed -1 (random) or 0..2^31-1, size 0 (original) or 128..4096.</summary>
    public static (long Seed, int Size) NormalizePreviewSettings(long seed, int size)
    {
        if (seed < -1 || seed > int.MaxValue)
        {
            seed = DefaultPreviewSeed;
        }
        if (size != 0 && (size < 128 || size > 4096))
        {
            size = DefaultPreviewSize;
        }
        return (seed, size);
    }

    public static ProfileSettings LoadProfileSettings(string profileDir)
    {
        string file = Path.Combine(profileDir, ProfileFileName);
        ProfileSettings settings = null;
        if (File.Exists(file))
        {
            try
            {
                settings = JsonConvert.DeserializeObject<ProfileSettings>(File.ReadAllText(file));
            }
            catch (Exception ex)
            {
                Logs.Warning($"[PromptGallery] Failed to read '{file}', using defaults: {ex.Message}");
            }
        }
        settings ??= new();
        if (!AllowedSeparators.Contains(settings.Separator))
        {
            settings.Separator = ", ";
        }
        settings.Description ??= "";
        if (string.IsNullOrWhiteSpace(settings.PreviewTemplate) || !settings.PreviewTemplate.Contains("{card}"))
        {
            settings.PreviewTemplate = DefaultPreviewTemplate;
        }
        settings.FolderTemplates = NormalizeFolderTemplates(settings.FolderTemplates);
        settings.FolderAspects = NormalizeFolderAspects(settings.FolderAspects);
        settings.PreviewAspect = CleanAspect(settings.PreviewAspect) ?? "";
        (settings.PreviewSeed, settings.PreviewSize) = NormalizePreviewSettings(settings.PreviewSeed, settings.PreviewSize);
        return settings;
    }

    static JObject ProfileToJson(string name, ProfileSettings settings) => new()
    {
        ["name"] = name,
        ["separator"] = settings.Separator,
        ["description"] = settings.Description,
        ["preview_template"] = settings.PreviewTemplate,
        ["preview_seed"] = settings.PreviewSeed,
        ["preview_size"] = settings.PreviewSize,
        ["folder_templates"] = JObject.FromObject(settings.FolderTemplates),
        ["preview_aspect"] = settings.PreviewAspect,
        ["folder_aspects"] = JObject.FromObject(settings.FolderAspects)
    };

    public static JArray ListProfiles()
    {
        Directory.CreateDirectory(Root);
        JArray result = [];
        foreach (string dir in Directory.EnumerateDirectories(Root).OrderBy(d => Path.GetFileName(d), StringComparer.OrdinalIgnoreCase))
        {
            string name = Path.GetFileName(dir);
            if (name.StartsWith('.'))
            {
                continue;
            }
            result.Add(ProfileToJson(name, LoadProfileSettings(dir)));
        }
        return result;
    }

    /// <summary>Creates, updates, or renames (when <paramref name="oldName"/> differs) a profile.</summary>
    public static JObject SaveProfile(string name, string separator, string description, string oldName, string previewTemplate = null, bool mustBeNew = false, long? previewSeed = null, int? previewSize = null, string previewAspect = null)
    {
        if (previewAspect is not null && CleanAspect(previewAspect) is null)
        {
            throw new GalleryException($"Unknown preview aspect ratio '{previewAspect}'. Use one of: {string.Join(", ", AllowedAspects)}, or empty for the Generate tab's.");
        }
        if (previewSeed is not null && (previewSeed < -1 || previewSeed > int.MaxValue))
        {
            throw new GalleryException("The preview seed must be -1 (random) or a number from 0 to 2147483647.");
        }
        if (previewSize is not null && previewSize != 0 && (previewSize < 128 || previewSize > 4096))
        {
            throw new GalleryException("The preview image size must be 0 (original) or from 128 to 4096 pixels.");
        }
        if (previewTemplate is not null && previewTemplate.Trim().Length > 0 && !previewTemplate.Contains("{card}"))
        {
            throw new GalleryException("The preview template must contain {card}.");
        }
        if ((previewTemplate?.Length ?? 0) > MaxPromptChars)
        {
            throw new GalleryException("The preview template is too long.");
        }
        string clean = CleanSegment(name) ?? throw new GalleryException("Invalid profile name. It cannot start or end with a dot or contain any of: \\ / : * ? \" < > |");
        if (!AllowedSeparators.Contains(separator))
        {
            throw new GalleryException("Invalid separator.");
        }
        lock (WriteLock)
        {
            Directory.CreateDirectory(Root);
            string target = Resolve(Root, clean);
            if (mustBeNew && Directory.Exists(target))
            {
                throw new GalleryException($"A profile named '{clean}' already exists.");
            }
            if (!string.IsNullOrWhiteSpace(oldName) && oldName.Trim() != clean)
            {
                string source = ProfileDir(oldName);
                bool caseOnlyRename = string.Equals(oldName.Trim(), clean, StringComparison.OrdinalIgnoreCase);
                if (Directory.Exists(target) && !caseOnlyRename)
                {
                    throw new GalleryException($"A profile named '{clean}' already exists.");
                }
                if (caseOnlyRename)
                {
                    string temp = source + ".renaming";
                    Directory.Move(source, temp);
                    Directory.Move(temp, target);
                }
                else
                {
                    Directory.Move(source, target);
                }
                DeleteCacheDir(oldName.Trim());
            }
            Directory.CreateDirectory(target);
            ProfileSettings settings = LoadProfileSettings(target);
            settings.Separator = separator;
            settings.Description = description ?? "";
            if (!string.IsNullOrWhiteSpace(previewTemplate))
            {
                settings.PreviewTemplate = previewTemplate.Trim();
            }
            settings.PreviewSeed = previewSeed ?? settings.PreviewSeed;
            settings.PreviewSize = previewSize ?? settings.PreviewSize;
            settings.PreviewAspect = previewAspect is null ? settings.PreviewAspect : CleanAspect(previewAspect);
            SaveProfileSettings(target, settings);
            return ProfileToJson(clean, settings);
        }
    }

    /// <summary>Deletes a profile. Only allowed when it holds no cards, to avoid accidental data loss.</summary>
    public static void DeleteProfile(string name)
    {
        lock (WriteLock)
        {
            string dir = ProfileDir(name);
            bool hasContent = Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).Any(f => !string.Equals(Path.GetFileName(f), ProfileFileName, StringComparison.OrdinalIgnoreCase) || Path.GetDirectoryName(f) != dir);
            if (hasContent)
            {
                throw new GalleryException("This profile still has cards in it. Delete or move them first.");
            }
            Directory.Delete(dir, true);
            DeleteCacheDir(Path.GetFileName(dir));
        }
    }

    static void DeleteCacheDir(string profile)
    {
        try
        {
            string cache = Resolve(CacheRoot, profile);
            if (Directory.Exists(cache))
            {
                Directory.Delete(cache, true);
            }
        }
        catch (Exception ex)
        {
            Logs.Debug($"[PromptGallery] Failed to clear thumbnail cache for '{profile}': {ex.Message}");
        }
    }

    #endregion

    #region Cards

    class CardScan
    {
        public string TextFile;
        public string ImageFile;
        public string ImageExt;
        public long Version;
    }

    /// <summary>Lists all folders and cards of a profile.</summary>
    public static JObject ListCards(string profile)
    {
        string dir = ProfileDir(profile);
        ProfileSettings settings = LoadProfileSettings(dir);
        JArray folders = [];
        foreach (string sub in Directory.EnumerateDirectories(dir, "*", SearchOption.AllDirectories))
        {
            string rel = ToRel(dir, sub);
            if (!IsHiddenRel(rel))
            {
                folders.Add(rel);
            }
        }
        Dictionary<string, CardScan> cards = new(StringComparer.OrdinalIgnoreCase);
        foreach (string file in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
        {
            string rel = ToRel(dir, file);
            if (IsHiddenRel(rel) || string.Equals(rel, ProfileFileName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            string ext = Path.GetExtension(rel).TrimStart('.').ToLowerInvariant();
            bool isText = ext == "txt";
            bool isImage = ImageExtensions.Contains(ext);
            if (!isText && !isImage)
            {
                continue;
            }
            string key = rel[..^(ext.Length + 1)];
            if (!cards.TryGetValue(key, out CardScan card))
            {
                card = new();
                cards[key] = card;
            }
            long modified = File.GetLastWriteTimeUtc(file).Ticks;
            card.Version = Math.Max(card.Version, modified);
            if (isText)
            {
                card.TextFile = file;
            }
            else if (card.ImageExt is null || Array.IndexOf(ImageExtensions, ext) < Array.IndexOf(ImageExtensions, card.ImageExt))
            {
                card.ImageFile = file;
                card.ImageExt = ext;
            }
        }
        JArray entries = [];
        foreach ((string key, CardScan card) in cards.OrderBy(c => c.Key, StringComparer.OrdinalIgnoreCase))
        {
            string prompt = "";
            if (card.TextFile is not null)
            {
                try
                {
                    prompt = File.ReadAllText(card.TextFile, Encoding.UTF8);
                    if (prompt.Length > MaxPromptChars)
                    {
                        prompt = prompt[..MaxPromptChars];
                    }
                    prompt = prompt.Replace("\r\n", "\n").TrimEnd('\n', '\r', ' ', '\t');
                }
                catch (Exception ex)
                {
                    Logs.Warning($"[PromptGallery] Failed to read '{card.TextFile}': {ex.Message}");
                }
            }
            entries.Add(new JObject()
            {
                ["path"] = key,
                ["prompt"] = prompt,
                ["has_image"] = card.ImageFile is not null,
                ["version"] = card.Version.ToString()
            });
        }
        return new JObject()
        {
            ["profile"] = ProfileToJson(Path.GetFileName(dir), settings),
            ["folders"] = folders,
            ["cards"] = entries
        };
    }

    /// <summary>Returns all existing files that belong to a card (text, images, sidecar json).</summary>
    public static List<string> CardFiles(string profileDir, string cardPath)
    {
        List<string> result = [];
        foreach (string ext in ImageExtensions.Append("txt").Append("json"))
        {
            string file = Resolve(profileDir, $"{cardPath}.{ext}");
            if (File.Exists(file))
            {
                result.Add(file);
            }
        }
        return result;
    }

    static string FindImage(string profileDir, string cardPath)
    {
        foreach (string ext in ImageExtensions)
        {
            string file = Resolve(profileDir, $"{cardPath}.{ext}");
            if (File.Exists(file))
            {
                return file;
            }
        }
        return null;
    }

    /// <summary>Creates or edits a card. Renames/moves it if <paramref name="oldPath"/> is set and differs.
    /// <paramref name="image"/>: a data URL to set the image, "clear" to remove it, or null/empty to keep it.</summary>
    public static JObject SaveCard(string profile, string path, string prompt, string image, string oldPath)
    {
        string dir = ProfileDir(profile);
        string cardPath = CleanRelPath(path, false, "card name");
        prompt = (prompt ?? "").Replace("\r\n", "\n");
        if (prompt.Length > MaxPromptChars)
        {
            throw new GalleryException("The prompt text is too long.");
        }
        byte[] imageBytes = null;
        string imageExt = null;
        if (!string.IsNullOrEmpty(image) && image != "clear")
        {
            (imageBytes, imageExt) = DecodeUpload(image);
        }
        lock (WriteLock)
        {
            string cleanOld = string.IsNullOrWhiteSpace(oldPath) ? null : CleanRelPath(oldPath, false, "old card name");
            bool isRename = cleanOld is not null && cleanOld != cardPath;
            bool isCaseOnlyRename = isRename && string.Equals(cleanOld, cardPath, StringComparison.OrdinalIgnoreCase);
            if (cleanOld is null || (isRename && !isCaseOnlyRename))
            {
                if (CardFiles(dir, cardPath).Count > 0)
                {
                    throw new GalleryException($"A card named '{cardPath}' already exists.");
                }
            }
            string textFile = Resolve(dir, $"{cardPath}.txt");
            Directory.CreateDirectory(Path.GetDirectoryName(textFile));
            if (isRename)
            {
                List<string> oldFiles = CardFiles(dir, cleanOld);
                if (oldFiles.Count == 0)
                {
                    throw new GalleryException($"Card '{cleanOld}' does not exist.");
                }
                foreach (string oldFile in oldFiles)
                {
                    string newFile = Resolve(dir, cardPath + Path.GetExtension(oldFile));
                    if (isCaseOnlyRename)
                    {
                        File.Move(oldFile, oldFile + ".renaming");
                        File.Move(oldFile + ".renaming", newFile);
                    }
                    else
                    {
                        File.Move(oldFile, newFile);
                    }
                }
                DeleteThumbnail(Path.GetFileName(dir), cleanOld);
            }
            File.WriteAllText(textFile, prompt, Utf8NoBom);
            if (imageBytes is not null || image == "clear")
            {
                foreach (string ext in ImageExtensions)
                {
                    string old = Resolve(dir, $"{cardPath}.{ext}");
                    if (File.Exists(old))
                    {
                        File.Delete(old);
                    }
                }
                if (imageBytes is not null)
                {
                    File.WriteAllBytes(Resolve(dir, $"{cardPath}.{imageExt}"), imageBytes);
                }
            }
            DeleteThumbnail(Path.GetFileName(dir), cardPath);
        }
        return new JObject() { ["path"] = cardPath };
    }

    /// <summary>Decodes and validates an uploaded image data URL.</summary>
    static (byte[], string) DecodeUpload(string dataUrl)
    {
        if (dataUrl.Length > MaxUploadChars)
        {
            throw new GalleryException("The image is too large.");
        }
        if (!dataUrl.StartsWith("data:") || !dataUrl.Contains(";base64,"))
        {
            throw new GalleryException("Invalid image data.");
        }
        string mime = dataUrl[5..dataUrl.IndexOf(";base64,")].ToLowerInvariant();
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(dataUrl[(dataUrl.IndexOf(";base64,") + ";base64,".Length)..]);
        }
        catch (FormatException)
        {
            throw new GalleryException("Invalid image data.");
        }
        try
        {
            ISImage.Identify(bytes);
        }
        catch (Exception)
        {
            throw new GalleryException("The file is not a readable image.");
        }
        if (UploadMimeToExt.TryGetValue(mime, out string ext))
        {
            return (bytes, ext);
        }
        // Other formats (bmp, gif, ...): convert to png.
        try
        {
            using ISImage img = ISImage.Load(bytes);
            using MemoryStream stream = new();
            img.SaveAsPng(stream);
            return (stream.ToArray(), "png");
        }
        catch (Exception)
        {
            throw new GalleryException($"Unsupported image type '{mime}'.");
        }
    }

    public static void DeleteCard(string profile, string path)
    {
        string dir = ProfileDir(profile);
        string cardPath = CleanRelPath(path, false, "card name");
        lock (WriteLock)
        {
            List<string> files = CardFiles(dir, cardPath);
            if (files.Count == 0)
            {
                throw new GalleryException($"Card '{cardPath}' does not exist.");
            }
            foreach (string file in files)
            {
                File.Delete(file);
            }
            DeleteThumbnail(Path.GetFileName(dir), cardPath);
        }
    }

    #endregion

    #region Folders

    public static void CreateFolder(string profile, string path)
    {
        string dir = ProfileDir(profile);
        string folder = CleanRelPath(path, false, "folder name");
        lock (WriteLock)
        {
            Directory.CreateDirectory(Resolve(dir, folder));
        }
    }

    /// <summary>Deletes a folder. Only allowed when it holds no cards.</summary>
    public static void DeleteFolder(string profile, string path)
    {
        string dir = ProfileDir(profile);
        string folder = CleanRelPath(path, false, "folder name");
        lock (WriteLock)
        {
            string full = Resolve(dir, folder);
            if (!Directory.Exists(full))
            {
                throw new GalleryException($"Folder '{folder}' does not exist.");
            }
            if (Directory.EnumerateFiles(full, "*", SearchOption.AllDirectories).Any())
            {
                throw new GalleryException("This folder is not empty. Delete or move its cards first.");
            }
            Directory.Delete(full, true);
            ProfileSettings settings = LoadProfileSettings(dir);
            bool inFolder(string k) => string.Equals(k, folder, StringComparison.OrdinalIgnoreCase) || k.StartsWith(folder + "/", StringComparison.OrdinalIgnoreCase);
            List<string> stale = [.. settings.FolderTemplates.Keys.Where(inFolder)];
            List<string> staleAspects = [.. settings.FolderAspects.Keys.Where(inFolder)];
            if (stale.Count > 0 || staleAspects.Count > 0)
            {
                stale.ForEach(k => settings.FolderTemplates.Remove(k));
                staleAspects.ForEach(k => settings.FolderAspects.Remove(k));
                SaveProfileSettings(dir, settings);
            }
        }
    }

    /// <summary>Sets (or with an empty template, clears) the preview prompt of a folder, and optionally its preview aspect ratio
    /// (null keeps it, empty inherits). Returns the updated profile.</summary>
    public static JObject SetFolderTemplate(string profile, string path, string template, string aspect = null)
    {
        if (aspect is not null && CleanAspect(aspect) is null)
        {
            throw new GalleryException($"Unknown preview aspect ratio '{aspect}'. Use one of: {string.Join(", ", AllowedAspects)}, or empty to inherit.");
        }
        string dir = ProfileDir(profile);
        string folder = CleanRelPath(path, false, "folder");
        template = (template ?? "").Trim();
        if (template.Length > 0 && !template.Contains("{card}"))
        {
            throw new GalleryException("The preview prompt must contain {card}.");
        }
        if (template.Length > MaxPromptChars)
        {
            throw new GalleryException("The preview prompt is too long.");
        }
        lock (WriteLock)
        {
            if (!Directory.Exists(Resolve(dir, folder)))
            {
                throw new GalleryException($"Folder '{folder}' does not exist.");
            }
            ProfileSettings settings = LoadProfileSettings(dir);
            if (template.Length == 0)
            {
                settings.FolderTemplates.Remove(folder);
            }
            else
            {
                settings.FolderTemplates[folder] = template;
            }
            if (aspect is not null)
            {
                string clean = CleanAspect(aspect);
                if (clean == "")
                {
                    settings.FolderAspects.Remove(folder);
                }
                else
                {
                    settings.FolderAspects[folder] = clean;
                }
            }
            SaveProfileSettings(dir, settings);
            return ProfileToJson(Path.GetFileName(dir), settings);
        }
    }

    #endregion

    #region Images

    static string ThumbnailFile(string profile, string cardPath) => Resolve(CacheRoot, $"{profile}/{cardPath}.jpg");

    public static void DeleteThumbnail(string profile, string cardPath)
    {
        try
        {
            string thumb = ThumbnailFile(profile, cardPath);
            if (File.Exists(thumb))
            {
                File.Delete(thumb);
            }
        }
        catch (Exception ex)
        {
            Logs.Debug($"[PromptGallery] Failed to delete thumbnail for '{cardPath}': {ex.Message}");
        }
    }

    /// <summary>Returns a card's image (or a cached thumbnail of it) as bytes + mime type, or null if it has none.</summary>
    public static (byte[], string)? GetImage(string profile, string path, bool thumbnail)
    {
        string dir = ProfileDir(profile);
        string cardPath = CleanRelPath(path, false, "card name");
        string source = FindImage(dir, cardPath);
        if (source is null)
        {
            return null;
        }
        if (!thumbnail)
        {
            string ext = Path.GetExtension(source).TrimStart('.').ToLowerInvariant();
            string mime = ext switch { "png" => "image/png", "webp" => "image/webp", _ => "image/jpeg" };
            return (File.ReadAllBytes(source), mime);
        }
        string thumb = ThumbnailFile(Path.GetFileName(dir), cardPath);
        if (File.Exists(thumb) && File.GetLastWriteTimeUtc(thumb) >= File.GetLastWriteTimeUtc(source))
        {
            return (File.ReadAllBytes(thumb), "image/jpeg");
        }
        byte[] data = MakeThumbnail(source);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(thumb));
            string temp = $"{thumb}.{Guid.NewGuid():N}.tmp";
            File.WriteAllBytes(temp, data);
            File.Move(temp, thumb, true);
        }
        catch (Exception ex)
        {
            Logs.Debug($"[PromptGallery] Failed to cache thumbnail '{thumb}': {ex.Message}");
        }
        return (data, "image/jpeg");
    }

    static byte[] MakeThumbnail(string source)
    {
        using Image<Rgba32> img = ISImage.Load<Rgba32>(source);
        img.Mutate(x =>
        {
            if (img.Width > ThumbnailSize || img.Height > ThumbnailSize)
            {
                x.Resize(new ResizeOptions() { Size = new Size(ThumbnailSize, ThumbnailSize), Mode = ResizeMode.Max });
            }
            x.BackgroundColor(Color.FromRgb(40, 40, 40));
        });
        using MemoryStream stream = new();
        img.SaveAsJpeg(stream, new JpegEncoder() { Quality = 85 });
        return stream.ToArray();
    }

    #endregion
}
