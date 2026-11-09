using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using System.IO;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using GalleryException = PromptGallery.GalleryStore.GalleryException;

namespace PromptGallery;

/// <summary>API routes for the prompt gallery.</summary>
public static class PromptGalleryAPI
{
    public static void Register()
    {
        API.RegisterAPICall(PromptGalleryListProfiles, false, PromptGalleryExtension.PermView);
        API.RegisterAPICall(PromptGalleryListCards, false, PromptGalleryExtension.PermView);
        API.RegisterAPICall(PromptGallerySaveProfile, true, PromptGalleryExtension.PermEdit);
        API.RegisterAPICall(PromptGalleryDeleteProfile, true, PromptGalleryExtension.PermEdit);
        API.RegisterAPICall(PromptGallerySaveCard, true, PromptGalleryExtension.PermEdit);
        API.RegisterAPICall(PromptGalleryDeleteCard, true, PromptGalleryExtension.PermEdit);
        API.RegisterAPICall(PromptGalleryCreateFolder, true, PromptGalleryExtension.PermEdit);
        API.RegisterAPICall(PromptGalleryDeleteFolder, true, PromptGalleryExtension.PermEdit);
        API.RegisterAPICall(PromptGallerySetFolderTemplate, true, PromptGalleryExtension.PermEdit);
    }

    /// <summary>Runs an action, converting gallery validation errors (and unexpected failures) into an API error object.</summary>
    static JObject Wrap(Func<JObject> action)
    {
        try
        {
            return action();
        }
        catch (GalleryStore.GalleryException ex)
        {
            return new JObject() { ["error"] = ex.Message };
        }
        catch (Exception ex)
        {
            Logs.Error($"[PromptGallery] Unexpected error: {ex.ReadableString()}");
            return new JObject() { ["error"] = "Prompt Gallery: unexpected server error, see the server logs." };
        }
    }

    static JObject Success() => new() { ["success"] = true };

    /// <summary>Like <see cref="Wrap"/>, then refreshes the profile's wildcard files if the action succeeded.
    /// The profile is taken from <paramref name="profile"/>, or from the result's "profile" field when that's empty.</summary>
    static JObject WrapAndSync(string profile, Func<JObject> action)
    {
        JObject result = Wrap(action);
        if (result["error"] is null)
        {
            string target = string.IsNullOrWhiteSpace(profile) ? result["profile"]?.ToString() : profile;
            if (!string.IsNullOrWhiteSpace(target))
            {
                GalleryWildcards.SyncProfile(target);
            }
        }
        return result;
    }

    [API.APIDescription("Lists all prompt gallery profiles.", "\"profiles\": [{\"name\": \"MOSS\", \"separator\": \", \", \"description\": \"\"}]")]
    public static async Task<JObject> PromptGalleryListProfiles(Session session)
    {
        return Wrap(() => new JObject()
        {
            ["profiles"] = GalleryStore.ListProfiles(),
            ["can_edit"] = session.User.HasPermission(PromptGalleryExtension.PermEdit)
        });
    }

    [API.APIDescription("Lists all folders and cards of a prompt gallery profile.", "\"profile\": {...}, \"folders\": [\"a\", \"a/b\"], \"cards\": [{\"path\": \"a/card\", \"prompt\": \"...\", \"has_image\": true, \"version\": \"123\"}]")]
    public static async Task<JObject> PromptGalleryListCards(Session session,
        [API.APIParameter("Profile name.")] string profile)
    {
        return Wrap(() =>
        {
            JObject result = GalleryStore.ListCards(profile);
            // Wildcard tag name per folder, for the random buttons.
            string name = result["profile"]["name"].ToString();
            JObject wildcards = [];
            foreach (JToken folder in result["folders"])
            {
                wildcards[folder.ToString()] = GalleryWildcards.WildcardName(name, folder.ToString());
            }
            result["wildcards"] = wildcards;
            return result;
        });
    }

    [API.APIDescription("Creates, updates or renames a prompt gallery profile.", "\"profile\": {...}")]
    public static async Task<JObject> PromptGallerySaveProfile(Session session,
        [API.APIParameter("Profile name.")] string name,
        [API.APIParameter("Separator used when inserting cards: ', ', '. ', newline, or space.")] string separator = ", ",
        [API.APIParameter("Optional description.")] string description = "",
        [API.APIParameter("Previous name, when renaming an existing profile.")] string old_name = "",
        [API.APIParameter("Prompt template for 'Generate Preview', must contain {card}. Empty keeps the current one.")] string preview_template = "",
        [API.APIParameter("Seed for previews, -1 for random. Empty keeps the current one.")] string preview_seed = "",
        [API.APIParameter("Longest side in pixels of saved preview images, 0 to keep the generated size. Empty keeps the current one.")] string preview_size = "",
        [API.APIParameter("Aspect ratio of generated previews, eg '2:3', or empty to use the Generate tab's. 'keep' keeps the current one.")] string preview_aspect = "keep")
    {
        JObject result = Wrap(() =>
        {
            long? seed = null;
            int? size = null;
            if (!string.IsNullOrWhiteSpace(preview_seed))
            {
                seed = long.TryParse(preview_seed.Trim(), out long parsedSeed) ? parsedSeed : throw new GalleryException("The preview seed must be a whole number.");
            }
            if (!string.IsNullOrWhiteSpace(preview_size))
            {
                size = int.TryParse(preview_size.Trim(), out int parsedSize) ? parsedSize : throw new GalleryException("The preview image size must be a whole number.");
            }
            return new JObject() { ["profile"] = GalleryStore.SaveProfile(name, separator, description, old_name, preview_template, previewSeed: seed, previewSize: size, previewAspect: preview_aspect == "keep" ? null : preview_aspect) };
        });
        if (result["error"] is null)
        {
            string newName = result["profile"]["name"].ToString();
            if (!string.IsNullOrWhiteSpace(old_name) && old_name.Trim() != newName)
            {
                GalleryWildcards.RemoveProfile(old_name.Trim());
            }
            GalleryWildcards.SyncProfile(newName);
        }
        return result;
    }

    [API.APIDescription("Deletes an empty prompt gallery profile.", "\"success\": true")]
    public static async Task<JObject> PromptGalleryDeleteProfile(Session session,
        [API.APIParameter("Profile name.")] string name)
    {
        return Wrap(() =>
        {
            GalleryStore.DeleteProfile(name);
            GalleryWildcards.RemoveProfile(name.Trim());
            return Success();
        });
    }

    [API.APIDescription("Creates or edits a prompt gallery card.", "\"path\": \"folder/card\"")]
    public static async Task<JObject> PromptGallerySaveCard(Session session,
        [API.APIParameter("Profile name.")] string profile,
        [API.APIParameter("Card path inside the profile, eg 'Styles/Watercolor'.")] string path,
        [API.APIParameter("Prompt text of the card.")] string prompt = "",
        [API.APIParameter("Image data URL to set, 'clear' to remove, or empty to keep.")] string image = "",
        [API.APIParameter("Previous path, when editing/renaming an existing card.")] string old_path = "")
    {
        return WrapAndSync(profile, () => GalleryStore.SaveCard(profile, path, prompt, image, old_path));
    }

    [API.APIDescription("Deletes a prompt gallery card.", "\"success\": true")]
    public static async Task<JObject> PromptGalleryDeleteCard(Session session,
        [API.APIParameter("Profile name.")] string profile,
        [API.APIParameter("Card path inside the profile.")] string path)
    {
        return WrapAndSync(profile, () =>
        {
            GalleryStore.DeleteCard(profile, path);
            return Success();
        });
    }

    [API.APIDescription("Sets the preview prompt of a folder (used by Generate Preview for its cards and subfolders). An empty template clears it.", "\"profile\": { ... }")]
    public static async Task<JObject> PromptGallerySetFolderTemplate(Session session,
        [API.APIParameter("Profile name.")] string profile,
        [API.APIParameter("Folder path inside the profile.")] string path,
        [API.APIParameter("Prompt template containing {card}, or empty to inherit from the parent folder or profile.")] string template = "",
        [API.APIParameter("Preview aspect ratio for this folder, eg '2:3', or empty to inherit. 'keep' keeps the current one.")] string aspect = "keep")
    {
        return Wrap(() => new JObject() { ["profile"] = GalleryStore.SetFolderTemplate(profile, path, template, aspect == "keep" ? null : aspect) });
    }

    [API.APIDescription("Creates a folder in a prompt gallery profile.", "\"success\": true")]
    public static async Task<JObject> PromptGalleryCreateFolder(Session session,
        [API.APIParameter("Profile name.")] string profile,
        [API.APIParameter("Folder path inside the profile.")] string path)
    {
        return WrapAndSync(profile, () =>
        {
            GalleryStore.CreateFolder(profile, path);
            return Success();
        });
    }

    [API.APIDescription("Deletes an empty folder from a prompt gallery profile.", "\"success\": true")]
    public static async Task<JObject> PromptGalleryDeleteFolder(Session session,
        [API.APIParameter("Profile name.")] string profile,
        [API.APIParameter("Folder path inside the profile.")] string path)
    {
        return WrapAndSync(profile, () =>
        {
            GalleryStore.DeleteFolder(profile, path);
            return Success();
        });
    }

    static bool CheckUser(HttpContext context, PermInfo perm)
    {
        User user = WebServer.GetUserFor(context);
        if (user is null || !user.HasPermission(perm))
        {
            context.Response.StatusCode = 401;
            return false;
        }
        return true;
    }

    static async Task WriteJson(HttpContext context, int status, JObject data)
    {
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/json; charset=utf-8";
        await context.Response.WriteAsync(data.ToString(Newtonsoft.Json.Formatting.None), Program.GlobalProgramCancel);
    }

    static string TempFile() => Path.Combine(Path.GetTempPath(), $"swarm-promptgallery-{Guid.NewGuid():N}.zip");

    static void TryDelete(string file)
    {
        try
        {
            File.Delete(file);
        }
        catch (Exception ex)
        {
            Logs.Debug($"[PromptGallery] Failed to delete temp file '{file}': {ex.Message}");
        }
    }

    /// <summary>Web route: GET /PromptGalleryExport/(profile)[?folder=a/b]. Downloads a profile or folder as a pack zip.</summary>
    public static async Task ExportPack(HttpContext context)
    {
        if (!CheckUser(context, PromptGalleryExtension.PermView))
        {
            return;
        }
        string profile = Uri.UnescapeDataString((context.Request.Path.Value ?? "")["/PromptGalleryExport/".Length..]);
        string folder = context.Request.Query["folder"].ToString();
        // ZipArchive writes synchronously, which Kestrel forbids on the response stream, so build it in a temp file first.
        string temp = TempFile();
        try
        {
            string name;
            try
            {
                using FileStream stream = File.Create(temp);
                name = GalleryPacks.Export(profile, folder, stream);
            }
            catch (GalleryStore.GalleryException ex)
            {
                await WriteJson(context, 400, new JObject() { ["error"] = ex.Message });
                return;
            }
            string fileName = new([.. name.Select(c => Path.GetInvalidFileNameChars().Contains(c) || c < 32 ? '_' : c)]);
            string asciiName = new([.. fileName.Select(c => c < 128 && c != '"' ? c : '_')]);
            context.Response.StatusCode = 200;
            context.Response.ContentType = "application/zip";
            context.Response.Headers.ContentDisposition = $"attachment; filename=\"{asciiName}.zip\"; filename*=UTF-8''{Uri.EscapeDataString(fileName)}.zip";
            context.Response.Headers.CacheControl = "no-store";
            context.Response.ContentLength = new FileInfo(temp).Length;
            await using FileStream read = File.OpenRead(temp);
            await read.CopyToAsync(context.Response.Body, Program.GlobalProgramCancel);
        }
        catch (Exception ex)
        {
            Logs.Error($"[PromptGallery] Export failed: {ex.ReadableString()}");
            if (!context.Response.HasStarted)
            {
                await WriteJson(context, 500, new JObject() { ["error"] = "Export failed, see the server logs." });
            }
        }
        finally
        {
            TryDelete(temp);
        }
    }

    /// <summary>Web route: POST /PromptGalleryImport?new_profile=X or ?profile=X&amp;folder=a/b, with the zip as the raw body.
    /// Requires the "X-PromptGallery: import" header, which a cross-site form cannot send without a CORS preflight.</summary>
    public static async Task ImportPack(HttpContext context)
    {
        if (!CheckUser(context, PromptGalleryExtension.PermEdit))
        {
            return;
        }
        if (context.Request.Headers["X-PromptGallery"].ToString() != "import")
        {
            await WriteJson(context, 400, new JObject() { ["error"] = "Missing request header." });
            return;
        }
        IHttpMaxRequestBodySizeFeature sizeFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (sizeFeature is not null && !sizeFeature.IsReadOnly)
        {
            sizeFeature.MaxRequestBodySize = GalleryPacks.MaxZipBytes;
        }
        if (context.Request.ContentLength > GalleryPacks.MaxZipBytes)
        {
            await WriteJson(context, 413, new JObject() { ["error"] = "The pack file is too large." });
            return;
        }
        string temp = TempFile();
        try
        {
            await using (FileStream write = File.Create(temp))
            {
                await context.Request.Body.CopyToAsync(write, Program.GlobalProgramCancel);
            }
            IQueryCollection query = context.Request.Query;
            JObject result = WrapAndSync(null, () => GalleryPacks.ImportZip(temp, query["new_profile"].ToString(), query["profile"].ToString(), query["folder"].ToString()));
            await WriteJson(context, 200, result);
        }
        catch (BadHttpRequestException)
        {
            await WriteJson(context, 413, new JObject() { ["error"] = "The pack file is too large." });
        }
        finally
        {
            TryDelete(temp);
        }
    }

    /// <summary>Web route: /PromptGalleryImage/(profile)/(card path)[?thumb=1]. Serves a card image or its thumbnail.</summary>
    public static async Task ViewImage(HttpContext context)
    {
        User user = WebServer.GetUserFor(context);
        if (user is null || !user.HasPermission(PromptGalleryExtension.PermView))
        {
            context.Response.StatusCode = 401;
            return;
        }
        string raw = (context.Request.Path.Value ?? "")["/PromptGalleryImage/".Length..];
        int slash = raw.IndexOf('/');
        if (slash <= 0)
        {
            context.Response.StatusCode = 404;
            return;
        }
        (byte[], string)? result;
        try
        {
            result = GalleryStore.GetImage(raw[..slash], raw[(slash + 1)..], context.Request.Query.ContainsKey("thumb"));
        }
        catch (GalleryStore.GalleryException)
        {
            result = null;
        }
        catch (Exception ex)
        {
            Logs.Warning($"[PromptGallery] Failed to serve image '{raw}': {ex.Message}");
            result = null;
        }
        if (result is null)
        {
            context.Response.StatusCode = 404;
            return;
        }
        (byte[] data, string mime) = result.Value;
        context.Response.StatusCode = 200;
        context.Response.ContentType = mime;
        context.Response.ContentLength = data.Length;
        // URLs carry a version query param that changes on edit, so caching is safe.
        context.Response.Headers.CacheControl = "private, max-age=604800";
        await context.Response.Body.WriteAsync(data, Program.GlobalProgramCancel);
    }
}
