using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Utils;
using System.IO;
using System.IO.Compression;

using ISImage = SixLabors.ImageSharp.Image;
using GalleryException = PromptGallery.GalleryStore.GalleryException;

namespace PromptGallery;

/// <summary>Prompt packs: a shareable set of cards.
/// A pack is a <c>.zip</c> file with <c>pack.json</c> (metadata) + <c>cards/(folders...)/(card).txt</c> + an optional image with the same base name.</summary>
public static class GalleryPacks
{
    public const string FormatId = "promptgallery-pack";

    public const int FormatVersion = 1;

    public const string MetaFileName = "pack.json";

    const string CardsPrefix = "cards/";

    /// <summary>Upper limit of an imported zip file.</summary>
    public const long MaxZipBytes = 1024L * 1024 * 1024;

    const int MaxEntries = 50_000;

    const long MaxImageBytes = 50L * 1024 * 1024;

    const long MaxTotalBytes = 2048L * 1024 * 1024;

    /// <summary>Pack metadata, stored as pack.json.</summary>
    public class PackMeta
    {
        [JsonProperty("format")]
        public string Format = FormatId;

        [JsonProperty("version")]
        public int Version = FormatVersion;

        [JsonProperty("name")]
        public string Name = "";

        [JsonProperty("description")]
        public string Description = "";

        [JsonProperty("author")]
        public string Author = "";

        [JsonProperty("separator")]
        public string Separator = ", ";

        [JsonProperty("preview_template")]
        public string PreviewTemplate = GalleryStore.DefaultPreviewTemplate;

        [JsonProperty("preview_seed")]
        public long PreviewSeed = GalleryStore.DefaultPreviewSeed;

        [JsonProperty("preview_size")]
        public int PreviewSize = GalleryStore.DefaultPreviewSize;

        /// <summary>Per-folder preview prompts, keyed by folder path inside the pack's cards/.</summary>
        [JsonProperty("folder_templates")]
        public Dictionary<string, string> FolderTemplates = [];

        [JsonProperty("preview_aspect")]
        public string PreviewAspect = "";

        /// <summary>Per-folder preview aspect ratios, keyed by folder path inside the pack's cards/.</summary>
        [JsonProperty("folder_aspects")]
        public Dictionary<string, string> FolderAspects = [];

        [JsonProperty("card_count")]
        public int CardCount = 0;
    }

    static PackMeta ParseMeta(string json)
    {
        PackMeta meta;
        try
        {
            meta = JsonConvert.DeserializeObject<PackMeta>(json) ?? new();
        }
        catch (Exception)
        {
            throw new GalleryException("The pack has an unreadable pack.json.");
        }
        if (meta.Format != FormatId)
        {
            throw new GalleryException("This is not a Prompt Gallery pack (pack.json has the wrong format).");
        }
        if (meta.Version > FormatVersion)
        {
            throw new GalleryException($"This pack uses a newer format (v{meta.Version}). Update the Prompt Gallery extension.");
        }
        meta.Name = (meta.Name ?? "").Trim();
        meta.Description ??= "";
        meta.Author ??= "";
        if (!GalleryStore.AllowedSeparators.Contains(meta.Separator))
        {
            meta.Separator = ", ";
        }
        if (string.IsNullOrWhiteSpace(meta.PreviewTemplate) || !meta.PreviewTemplate.Contains("{card}"))
        {
            meta.PreviewTemplate = GalleryStore.DefaultPreviewTemplate;
        }
        meta.FolderTemplates = GalleryStore.NormalizeFolderTemplates(meta.FolderTemplates);
        meta.FolderAspects = GalleryStore.NormalizeFolderAspects(meta.FolderAspects);
        meta.PreviewAspect = GalleryStore.CleanAspect(meta.PreviewAspect) ?? "";
        (meta.PreviewSeed, meta.PreviewSize) = GalleryStore.NormalizePreviewSettings(meta.PreviewSeed, meta.PreviewSize);
        return meta;
    }

    #region Sources

    /// <summary>One file of a pack.</summary>
    record PackFile(string Path, long Length, Func<Stream> Open);

    static IEnumerable<PackFile> ZipFiles(ZipArchive zip) =>
        zip.Entries.Where(e => !e.FullName.EndsWith('/') && !e.FullName.EndsWith('\\'))
            .Select(e => new PackFile(e.FullName.Replace('\\', '/'), e.Length, e.Open));

    /// <summary>Reads a whole entry, refusing to go past <paramref name="limit"/> bytes even if the declared length lies.</summary>
    static byte[] ReadLimited(PackFile file, long limit)
    {
        if (file.Length > limit)
        {
            return null;
        }
        using Stream stream = file.Open();
        using MemoryStream result = new();
        byte[] buffer = new byte[81920];
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
        {
            if (result.Length + read > limit)
            {
                return null;
            }
            result.Write(buffer, 0, read);
        }
        return result.ToArray();
    }

    #endregion

    #region Import

    /// <summary>Imports a pack from a zip file on disk.</summary>
    public static JObject ImportZip(string zipFile, string newProfile, string profile, string folder)
    {
        ZipArchive zip;
        try
        {
            zip = ZipFile.OpenRead(zipFile);
        }
        catch (Exception)
        {
            throw new GalleryException("The file is not a valid zip archive.");
        }
        using (zip)
        {
            if (zip.Entries.Count > MaxEntries)
            {
                throw new GalleryException($"The pack has too many files (max {MaxEntries}).");
            }
            return Import(ZipFiles(zip).ToList(), newProfile, profile, folder);
        }
    }

    class PendingCard
    {
        public PackFile Text;
        public PackFile Image;
        public string ImageExt;
    }

    /// <summary>Imports pack files either into a new profile (<paramref name="newProfile"/> set) or into a folder of an existing profile.
    /// Existing cards are never overwritten: conflicting cards are skipped and reported.</summary>
    static JObject Import(List<PackFile> files, string newProfile, string profile, string folder)
    {
        PackFile metaFile = files.FirstOrDefault(f => string.Equals(f.Path, MetaFileName, StringComparison.OrdinalIgnoreCase));
        if (metaFile is null)
        {
            throw new GalleryException("This is not a Prompt Gallery pack (pack.json is missing).");
        }
        byte[] metaBytes = ReadLimited(metaFile, 1024 * 1024) ?? throw new GalleryException("pack.json is too large.");
        PackMeta meta = ParseMeta(Encoding.UTF8.GetString(metaBytes));
        if (files.Sum(f => Math.Max(0, f.Length)) > MaxTotalBytes)
        {
            throw new GalleryException("The pack is too large when unpacked.");
        }
        List<string> problems = [];
        int invalid = 0;
        void Problem(string message)
        {
            invalid++;
            if (problems.Count < 20)
            {
                problems.Add(message);
            }
        }
        // Group files into cards by their path without extension.
        Dictionary<string, PendingCard> cards = new(StringComparer.OrdinalIgnoreCase);
        foreach (PackFile file in files)
        {
            if (file == metaFile || !file.Path.StartsWith(CardsPrefix, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            string rel = file.Path[CardsPrefix.Length..];
            if (rel.Split('/').Any(p => p.StartsWith('.') || p == "__MACOSX"))
            {
                continue;
            }
            string ext = Path.GetExtension(rel).TrimStart('.').ToLowerInvariant();
            bool isText = ext == "txt";
            bool isImage = GalleryStore.ImageExtensions.Contains(ext);
            if (!isText && !isImage)
            {
                continue;
            }
            string key;
            try
            {
                key = GalleryStore.CleanRelPath(rel[..^(ext.Length + 1)], false, "card name");
            }
            catch (GalleryException)
            {
                Problem($"Invalid name: {rel}");
                continue;
            }
            if (!cards.TryGetValue(key, out PendingCard card))
            {
                card = new();
                cards[key] = card;
            }
            if (isText)
            {
                card.Text = file;
            }
            else if (card.ImageExt is null || Array.IndexOf(GalleryStore.ImageExtensions, ext) < Array.IndexOf(GalleryStore.ImageExtensions, card.ImageExt))
            {
                card.Image = file;
                card.ImageExt = ext;
            }
        }
        if (cards.Count == 0)
        {
            throw new GalleryException("The pack has no cards.");
        }
        string targetFolder = GalleryStore.CleanRelPath(folder, true, "folder");
        string profileName;
        if (!string.IsNullOrWhiteSpace(newProfile))
        {
            profileName = GalleryStore.SaveProfile(newProfile, meta.Separator, meta.Description, null, meta.PreviewTemplate, mustBeNew: true, previewSeed: meta.PreviewSeed, previewSize: meta.PreviewSize, previewAspect: meta.PreviewAspect)["name"].ToString();
            targetFolder = "";
        }
        else
        {
            profileName = Path.GetFileName(GalleryStore.ProfileDir(profile));
        }
        string dir = GalleryStore.ProfileDir(profileName);
        int imported = 0, skipped = 0;
        foreach ((string key, PendingCard card) in cards.OrderBy(c => c.Key, StringComparer.OrdinalIgnoreCase))
        {
            string cardPath = targetFolder == "" ? key : $"{targetFolder}/{key}";
            string prompt = "";
            if (card.Text is not null)
            {
                byte[] text = ReadLimited(card.Text, GalleryStore.MaxPromptChars * 4L);
                if (text is null)
                {
                    Problem($"Text too long: {key}");
                    continue;
                }
                prompt = Encoding.UTF8.GetString(text).TrimStart('﻿').Replace("\r\n", "\n");
                if (prompt.Length > GalleryStore.MaxPromptChars)
                {
                    Problem($"Text too long: {key}");
                    continue;
                }
            }
            byte[] image = null;
            if (card.Image is not null)
            {
                image = ReadLimited(card.Image, MaxImageBytes);
                try
                {
                    if (image is null)
                    {
                        throw new GalleryException("too large");
                    }
                    ISImage.Identify(image);
                }
                catch (Exception)
                {
                    Problem($"Image skipped (unreadable or too large): {key}");
                    image = null;
                }
            }
            if (card.Text is null && image is null)
            {
                continue;
            }
            lock (GalleryStore.WriteLock)
            {
                if (GalleryStore.CardFiles(dir, cardPath).Count > 0)
                {
                    skipped++;
                    continue;
                }
                string textFile = GalleryStore.Resolve(dir, $"{cardPath}.txt");
                Directory.CreateDirectory(Path.GetDirectoryName(textFile));
                File.WriteAllText(textFile, prompt, GalleryStore.Utf8NoBom);
                if (image is not null)
                {
                    File.WriteAllBytes(GalleryStore.Resolve(dir, $"{cardPath}.{card.ImageExt}"), image);
                }
                GalleryStore.DeleteThumbnail(profileName, cardPath);
            }
            imported++;
        }
        // Folder preview prompts: only for folders that exist now, never replacing one the user already set.
        if (meta.FolderTemplates.Count > 0 || meta.FolderAspects.Count > 0)
        {
            lock (GalleryStore.WriteLock)
            {
                GalleryStore.ProfileSettings settings = GalleryStore.LoadProfileSettings(dir);
                bool changed = false;
                foreach ((string packFolder, string template) in meta.FolderTemplates)
                {
                    string key = targetFolder == "" ? packFolder : $"{targetFolder}/{packFolder}";
                    if (!settings.FolderTemplates.ContainsKey(key) && Directory.Exists(GalleryStore.Resolve(dir, key)))
                    {
                        settings.FolderTemplates[key] = template;
                        changed = true;
                    }
                }
                foreach ((string packFolder, string aspect) in meta.FolderAspects)
                {
                    string key = targetFolder == "" ? packFolder : $"{targetFolder}/{packFolder}";
                    if (!settings.FolderAspects.ContainsKey(key) && Directory.Exists(GalleryStore.Resolve(dir, key)))
                    {
                        settings.FolderAspects[key] = aspect;
                        changed = true;
                    }
                }
                if (changed)
                {
                    GalleryStore.SaveProfileSettings(dir, settings);
                }
            }
        }
        return new JObject()
        {
            ["profile"] = profileName,
            ["folder"] = targetFolder,
            ["pack_name"] = meta.Name,
            ["imported"] = imported,
            ["skipped_existing"] = skipped,
            ["skipped_invalid"] = invalid,
            ["problems"] = new JArray(problems)
        };
    }

    #endregion

    #region Export

    /// <summary>Writes a profile (or one of its folders) as a pack zip into <paramref name="output"/>. Returns a suggested file name.</summary>
    public static string Export(string profile, string folder, Stream output)
    {
        string dir = GalleryStore.ProfileDir(profile);
        string profileName = Path.GetFileName(dir);
        string cleanFolder = GalleryStore.CleanRelPath(folder, true, "folder");
        string sourceDir = cleanFolder == "" ? dir : GalleryStore.Resolve(dir, cleanFolder);
        if (!Directory.Exists(sourceDir))
        {
            throw new GalleryException($"Folder '{cleanFolder}' does not exist.");
        }
        // A folder export keeps the folder's own name, so importing it creates that folder.
        string baseDir = cleanFolder == "" ? dir : Path.GetDirectoryName(sourceDir);
        GalleryStore.ProfileSettings settings = GalleryStore.LoadProfileSettings(dir);
        List<(string Rel, string File)> entries = [];
        HashSet<string> cardKeys = new(StringComparer.OrdinalIgnoreCase);
        foreach (string file in Directory.EnumerateFiles(sourceDir, "*", SearchOption.AllDirectories))
        {
            string rel = GalleryStore.ToRel(baseDir, file);
            string relToProfile = GalleryStore.ToRel(dir, file);
            if (GalleryStore.IsHiddenRel(relToProfile) || string.Equals(relToProfile, GalleryStore.ProfileFileName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            string ext = Path.GetExtension(rel).TrimStart('.').ToLowerInvariant();
            if (ext != "txt" && !GalleryStore.ImageExtensions.Contains(ext))
            {
                continue;
            }
            entries.Add((rel, file));
            cardKeys.Add(rel[..^(ext.Length + 1)]);
        }
        string name = cleanFolder == "" ? profileName : $"{profileName} - {cleanFolder.Replace('/', ' ')}";
        // Folder preview prompts, keyed like the cards (relative to the export base).
        string parentPrefix = cleanFolder.Contains('/') ? cleanFolder[..(cleanFolder.LastIndexOf('/') + 1)] : "";
        Dictionary<string, string> folderTemplates = [];
        foreach ((string key, string template) in settings.FolderTemplates)
        {
            if (cleanFolder == "" || string.Equals(key, cleanFolder, StringComparison.OrdinalIgnoreCase) || key.StartsWith(cleanFolder + "/", StringComparison.OrdinalIgnoreCase))
            {
                folderTemplates[key[parentPrefix.Length..]] = template;
            }
        }
        // An exported folder keeps the prompt it inherits from a parent folder that isn't part of the pack.
        if (cleanFolder != "" && !settings.FolderTemplates.ContainsKey(cleanFolder))
        {
            string inherited = GalleryStore.EffectiveTemplate(settings, cleanFolder);
            if (inherited != settings.PreviewTemplate)
            {
                folderTemplates[cleanFolder[parentPrefix.Length..]] = inherited;
            }
        }
        Dictionary<string, string> folderAspects = [];
        foreach ((string key, string aspect) in settings.FolderAspects)
        {
            if (cleanFolder == "" || string.Equals(key, cleanFolder, StringComparison.OrdinalIgnoreCase) || key.StartsWith(cleanFolder + "/", StringComparison.OrdinalIgnoreCase))
            {
                folderAspects[key[parentPrefix.Length..]] = aspect;
            }
        }
        if (cleanFolder != "" && !settings.FolderAspects.ContainsKey(cleanFolder))
        {
            string inherited = GalleryStore.EffectiveAspect(settings, cleanFolder);
            if (inherited != settings.PreviewAspect)
            {
                folderAspects[cleanFolder[parentPrefix.Length..]] = inherited;
            }
        }
        PackMeta meta = new()
        {
            Name = name,
            Description = settings.Description,
            Separator = settings.Separator,
            PreviewTemplate = settings.PreviewTemplate,
            PreviewSeed = settings.PreviewSeed,
            PreviewSize = settings.PreviewSize,
            FolderTemplates = folderTemplates,
            PreviewAspect = settings.PreviewAspect,
            FolderAspects = folderAspects,
            CardCount = cardKeys.Count
        };
        using (ZipArchive zip = new(output, ZipArchiveMode.Create, true, Encoding.UTF8))
        {
            ZipArchiveEntry metaEntry = zip.CreateEntry(MetaFileName, CompressionLevel.Optimal);
            using (Stream stream = metaEntry.Open())
            {
                byte[] bytes = GalleryStore.Utf8NoBom.GetBytes(JsonConvert.SerializeObject(meta, Formatting.Indented));
                stream.Write(bytes);
            }
            foreach ((string rel, string file) in entries.OrderBy(e => e.Rel, StringComparer.OrdinalIgnoreCase))
            {
                bool isImage = !rel.EndsWith(".txt", StringComparison.OrdinalIgnoreCase);
                // Images are already compressed; storing them is much faster and barely bigger.
                zip.CreateEntryFromFile(file, CardsPrefix + rel, isImage ? CompressionLevel.NoCompression : CompressionLevel.Optimal);
            }
        }
        return name;
    }

    #endregion
}
