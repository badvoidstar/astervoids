using System.Text;
using System.Text.Json;
using AstervoidsWeb.Configuration;

namespace AstervoidsWeb.Tests;

public class SharedConfigurationTests
{
    [Theory]
    [InlineData(1)]
    [InlineData(12)]
    [InlineData(byte.MaxValue)]
    public void ReadsConfiguredMaximumWithoutSubstitutingADefault(int maximum)
    {
        using var source = new MemoryStream(Encoding.UTF8.GetBytes(
            $$"""{"identityTagMaxLength":{{maximum}}}"""));
        Assert.Equal(maximum, SharedConfiguration.Read(source).IdentityTagMaxLength);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(256)]
    public void RejectsLimitsThatCannotFitTheTagLengthField(int maximum)
    {
        using var source = new MemoryStream(Encoding.UTF8.GetBytes(
            $$"""{"identityTagMaxLength":{{maximum}}}"""));
        Assert.Throws<InvalidDataException>(() => SharedConfiguration.Read(source));
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"identityTagMaxLength":"12"}""")]
    [InlineData("""{"identityTagMaxLength":1.5}""")]
    [InlineData("""{"IdentityTagMaxLength":12}""")]
    [InlineData("""{"identityTagMaxLength":12,"unknown":1}""")]
    public void RejectsMissingOrMalformedConfiguration(string json)
    {
        using var source = new MemoryStream(Encoding.UTF8.GetBytes(json));
        Assert.Throws<JsonException>(() => SharedConfiguration.Read(source));
    }
}
