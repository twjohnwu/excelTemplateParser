from app.core.exceptions import (
    ConfigError,
    CoreError,
    JoinKeyMissing,
    MappingError,
    RegexTimeout,
    TemplateInvalid,
    WriterError,
)


def test_core_error_carries_messages_and_context():
    err = CoreError("user msg", tech_detail="tech", foo="bar", n=3)
    assert err.user_message == "user msg"
    assert err.tech_detail == "tech"
    assert err.context == {"foo": "bar", "n": 3}
    assert str(err) == "user msg"


def test_subclasses_inherit_signature():
    for cls in (ConfigError, JoinKeyMissing, MappingError, RegexTimeout, WriterError, TemplateInvalid):
        e = cls("u", tech_detail="t", x=1)
        assert isinstance(e, CoreError)
        assert e.user_message == "u"
        assert e.tech_detail == "t"
        assert e.context == {"x": 1}


def test_default_tech_detail_and_empty_context():
    err = ConfigError("just user")
    assert err.tech_detail == ""
    assert err.context == {}
